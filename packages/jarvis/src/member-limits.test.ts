// When a member's messages get a turn, and when they're passed on to you instead (D62): bursts fold
// into one turn, the limits hold however fast someone writes, a pause or Jarvis being down sends a
// fixed note and a relay, and your own turns always come first.
import { memberPrincipal } from "@hearth/core";
import { jarvisTurn, slackOutbox, slackThread } from "@hearth/db";
import { newId, ownerCaller, setSetting } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNextTurn } from "./claim.ts";
import { type MemberTest, memberTest, person, SAM, SAM_DM } from "./member-testing.ts";

let t: MemberTest;
beforeEach(async () => {
  t = await memberTest();
});
afterEach(() => t.h.destroy());

const notes = async () =>
  (await t.outbox()).filter((r) => r.kind === "note").map((r) => r.dedupeKey.split(":")[1]);

describe("a burst of messages", () => {
  it("is one turn that reads them all", async () => {
    t.h.brain.next([{ say: "All three, noted." }]);
    await t.write(SAM, "Hi");
    t.h.clock.advance(700);
    await t.write(SAM, "Quick question");
    t.h.clock.advance(700);
    await t.write(SAM, "When is the demo?");
    await t.tick();
    await t.drain();
    expect(await t.turns()).toHaveLength(1);
    const { prompt } = t.h.brain.requests[0]!;
    for (const said of ["Hi", "Quick question", "When is the demo?"])
      expect(prompt).toContain(said);
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual(["All three, noted."]);
  });

  it("of fifty in a minute is at most two turns and one busy note", async () => {
    t.h.brain.otherwise([{ say: "On it." }]);
    let written = 0;
    // A message every 1.2 s, the take loop every 2 s, and Jarvis free every 30 s.
    for (let ms = 0; ms <= 60_000; ms += 100) {
      if (ms % 1200 === 0 && written < 50) await t.write(SAM, `Message ${++written}`);
      if (ms % 2000 === 0) await t.take();
      if (ms > 0 && ms % 30_000 === 0) await t.drain();
      t.h.clock.advance(100);
    }
    expect(written).toBe(50);
    expect((await t.turns()).length).toBeLessThanOrEqual(2);
    expect(await notes()).toEqual(["busy"]);
    // Nothing is lost: each was answered, passed on, or still waits its turn (the last one, just
    // written, isn't taken yet).
    const outcomes = new Set((await t.inbound()).map((r) => r.outcome));
    for (const o of outcomes) expect(["answered", "relayed", "waiting", null]).toContain(o);
    expect(await t.cards("slack.member")).toHaveLength(1);
  });

  it("past the member's ten-minute budget is passed on", async () => {
    t.h.brain.otherwise([{ say: "Sure." }]);
    for (let i = 1; i <= 5; i++) {
      await t.write(SAM, `Question ${i}`);
      await t.tick();
      await t.drain();
      t.h.clock.advance(60_000);
    }
    expect(await t.turns()).toHaveLength(4);
    expect(await notes()).toEqual(["busy"]);
    expect((await t.inbound()).at(-1)!.outcome).toBe("relayed");
  });
});

describe("no turn", () => {
  it("while Jarvis is paused: a note and a relay", async () => {
    await setSetting(t.h.tdb.db, "jarvis.paused", true);
    await t.write(SAM, "Are you there?");
    await t.tick();
    await t.drain();
    expect(await t.turns()).toEqual([]);
    expect(t.h.brain.requests).toEqual([]);
    await t.send();
    expect(t.s.posts).toEqual([
      expect.objectContaining({
        channel: SAM_DM,
        text: "I'm paused at the moment, so I've passed your message on to Ana.",
      }),
    ]);
    const [card] = await t.cards("slack.member");
    expect(card).toMatchObject({
      title: "Sam Lee wrote to Jarvis on Slack, and it couldn't answer",
    });
    expect(card!.body).toContain("Are you there?");
  });

  it("when Jarvis was down for eleven minutes: an apology and a relay, from the take loop", async () => {
    await t.write(SAM, "Is the release today?");
    await t.tick();
    expect(await t.turns()).toMatchObject([{ status: "queued" }]);
    t.h.clock.advance(11 * 60_000);
    await t.tick();
    expect(await t.turns()).toMatchObject([{ status: "skipped", skipReason: "expired" }]);
    await t.drain();
    expect(t.h.brain.requests).toEqual([]);
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual([
      "Sorry, I couldn't answer this time. I've passed your message on to Ana.",
    ]);
    expect(await t.cards("slack.member")).toHaveLength(1);
    expect((await t.inbound()).map((r) => r.outcome)).toEqual(["relayed"]);
  });

  it("for a message only seen hours later, or too long to take in", async () => {
    await t.write(SAM, "Sent while Jarvis was off");
    t.h.clock.advance(3 * 3_600_000);
    await t.tick();
    await t.write(SAM, "x".repeat(4000));
    await t.tick();
    expect(await t.turns()).toEqual([]);
    expect(await notes()).toEqual(["late", "too_long"]);
  });

  it("when Jarvis keeps posting in one conversation: it pauses for an hour and tells you", async () => {
    t.h.brain.next([{ say: "Hello." }]);
    await t.write(SAM, "Hello");
    await t.tick();
    await t.drain();
    const [turn] = await t.turns();
    const now = t.h.clock.now();
    await t.h.tdb.db.insert(slackOutbox).values(
      Array.from({ length: 20 }, (_, i) => ({
        id: newId(),
        dedupeKey: `loop:${i}`,
        teamId: "T1",
        channelId: SAM_DM,
        text: `Echo ${i}`,
        kind: "note" as const,
        conversationId: turn!.conversationId,
        createdBy: memberPrincipal("T1", SAM),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
      })),
    );
    await t.write(SAM, "Echo?");
    await t.tick();
    expect(await t.turns()).toHaveLength(1);
    expect(await t.cards("slack.loop")).toHaveLength(1);
    const [thread] = await t.h.tdb.db
      .select()
      .from(slackThread)
      .where(eq(slackThread.conversationId, turn!.conversationId!));
    expect(thread!.pausedUntil!.getTime()).toBe(t.h.clock.now().getTime() + 3_600_000);
    expect(await notes()).toContain("paused");
  });

  it("with members off: nothing is taken at all", async () => {
    await setSetting(t.h.tdb.db, "slack.bot.membersOn", false);
    await t.write(SAM, "Hello?");
    expect(await t.tick()).toEqual({ taken: 0, turns: 0, relayed: 0, settled: 0 });
    expect((await t.inbound()).map((r) => r.outcome)).toEqual([null]);
  });
});

describe("who's answered", () => {
  it("never a guest, someone from another org, a deactivated user, a bot or someone Slack doesn't know", async () => {
    t.s.users.set("UGUEST", person("UGUEST", { guest: true }));
    t.s.users.set("UOTHER", person("UOTHER", { teamId: "T2" }));
    t.s.users.set("UGONE", person("UGONE", { deleted: true }));
    t.s.users.set("UBOT", person("UBOT", { bot: true }));
    for (const u of ["UGUEST", "UOTHER", "UGONE", "UBOT", "UNOBODY"]) await t.write(u, "Hi Jarvis");
    await t.tick();
    expect(await t.turns()).toEqual([]);
    expect(await t.outbox()).toEqual([]);
    expect(await t.cards()).toEqual([]);
    expect(Object.fromEntries((await t.inbound()).map((r) => [r.userId, r.outcome]))).toEqual({
      UGUEST: "ignored:guest",
      UOTHER: "ignored:external",
      UGONE: "ignored:deactivated",
      UBOT: "ignored:bot",
      UNOBODY: "ignored:deactivated",
    });
  });

  it("not someone you've blocked: one note a day, and nothing passed on", async () => {
    await t.setSam({ tier: "blocked" });
    await t.write(SAM, "Hello");
    await t.tick();
    await t.write(SAM, "Hello again");
    await t.tick();
    expect(await t.turns()).toEqual([]);
    expect(await t.cards()).toEqual([]);
    expect(await notes()).toEqual(["blocked"]);
    expect((await t.inbound()).map((r) => r.outcome)).toEqual(["blocked", "blocked"]);
  });
});

describe("claiming", () => {
  it("runs your chat first, and one member's turn at a time", async () => {
    t.s.users.set("UBO", person("UBO", { realName: "Bo Ray" }));
    await t.write(SAM, "First in line");
    await t.write("UBO", "Me too");
    await t.tick();
    await t.ok("chat.send", { text: "What's on today?" }, ownerCaller());
    await t.h.engine.processAvailable();
    const claim = () => claimNextTurn(t.h.kernel, t.h.clock.now());
    const first = await claim();
    expect(first).toMatchObject({ trigger: "chat" });
    const second = await claim();
    expect(second).toMatchObject({ trigger: "slack_member" });
    expect(second!.context.member).toBe(memberPrincipal("T1", SAM));
    // Bo waits while Sam's turn runs.
    expect(await claim()).toBeNull();
    // A chat you send now is still claimed.
    await t.ok("chat.send", { text: "And tomorrow?" }, ownerCaller());
    await t.h.engine.processAvailable();
    expect(await claim()).toMatchObject({ trigger: "chat" });
    await t.h.tdb.db
      .update(jarvisTurn)
      .set({ status: "done", finishedAt: t.h.clock.now() })
      .where(eq(jarvisTurn.id, second!.id));
    expect((await claim())!.context.member).toBe(memberPrincipal("T1", "UBO"));
  });
});
