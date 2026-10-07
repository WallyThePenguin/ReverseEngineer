// A post to a member checked once more as the outbox sends it (D62). An answer that went on its
// own doesn't go once you've lowered their tier or put their replies on review while it waited,
// and you're told why, with all of its text; one you said yes to still goes. A fixed note doesn't
// go to someone you've blocked since, or with members off, and nobody needs telling; one in your
// own DM always goes.
import { PRINCIPAL } from "@hearth/core";
import { approval, jarvisTurn, slackOutbox } from "@hearth/db";
import { newId, ownerCaller, setSetting } from "@hearth/kernel";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemberTest, memberTest, SAM } from "./member-testing.ts";

let t: MemberTest;
beforeEach(async () => {
  t = await memberTest();
});
afterEach(() => t.h.destroy());

async function ask(text: string, answer: string) {
  t.h.brain.next([{ say: answer }]);
  await t.write(SAM, text);
  await t.tick();
  await t.drain();
}

describe("an answer waiting to go", () => {
  it("doesn't go once you've lowered their tier, and you're told why, with its text", async () => {
    await t.setSam({ tier: "schedule" });
    await ask("When is Ana free?", "Ana's free Tuesday at 3.");
    await t.setSam({ tier: "relay" });
    await t.send();
    expect(t.s.posts).toEqual([]);
    const why = "You lowered them to relay while this waited.";
    expect(await t.outbox()).toMatchObject([{ kind: "answer", state: "failed", error: why }]);
    const [card] = await t.cards("slack.not_sent");
    expect(card).toMatchObject({
      title: "Jarvis's Slack message to Sam Lee didn't go out",
      body: `${why}\n\nAna's free Tuesday at 3.`,
    });
  });

  it("doesn't go once you've put their replies on review, and the card has all of it", async () => {
    const answer = `Hello Sam. ${"Here's the plan, step by step. ".repeat(20).trim()}`;
    await ask("Hi", answer);
    await t.setSam({ replies: "review" });
    await t.send();
    expect(t.s.posts).toEqual([]);
    const why = "You set replies to them to wait for your yes while this waited.";
    expect(await t.outbox()).toMatchObject([{ state: "failed", error: why }]);
    expect((await t.cards("slack.not_sent"))[0]!.body).toBe(`${why}\n\n${answer}`);
  });

  it("doesn't go at relay when it was written before Hearth noted the tier", async () => {
    const unnoted = () =>
      t.h.tdb.db.update(jarvisTurn).set({ context: sql`${jarvisTurn.context} - 'answeredAs'` });
    await ask("Hi", "Hello Sam.");
    await unnoted();
    await t.send();
    expect(t.s.posts).toEqual([]);
    expect(await t.outbox()).toMatchObject([
      {
        state: "failed",
        error: "They're at relay now, and Hearth can't tell whether this says more than that.",
      },
    ]);
    // Whatever it was written at, schedule allows it.
    await t.setSam({ tier: "schedule" });
    t.h.clock.advance(60_000);
    await ask("Still there?", "Still here.");
    await unnoted();
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual(["Still here."]);
  });

  it("still goes when you raised their tier, or said yes to it yourself", async () => {
    await ask("Hi", "Hello Sam.");
    await t.setSam({ tier: "schedule" });
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual(["Hello Sam."]);

    await t.setSam({ replies: "review" });
    t.h.clock.advance(60_000);
    await ask("When is Ana free?", "Ana's free Tuesday at 3.");
    const [held] = await t.h.tdb.db
      .select()
      .from(approval)
      .where(eq(approval.action, "slack.reply"));
    await t.h.kernel.decideApproval(held!.id, "approve", ownerCaller());
    await t.setSam({ tier: "relay" });
    await t.send();
    // You read it before it went.
    expect(t.s.posts.map((p) => p.text)).toEqual(["Hello Sam.", "Ana's free Tuesday at 3."]);
  });
});

describe("a note waiting to go", () => {
  /** Jarvis is paused, so what Sam writes is passed on to you with a note to them. */
  async function noteQueued() {
    await setSetting(t.h.tdb.db, "jarvis.paused", true);
    await t.write(SAM, "Are you there?");
    await t.tick();
    expect(await t.outbox()).toMatchObject([{ kind: "note", state: "queued" }]);
  }

  it("doesn't go to someone you've blocked since, and nobody's told", async () => {
    await noteQueued();
    await t.setSam({ tier: "blocked" });
    await t.send();
    expect(t.s.posts).toEqual([]);
    expect(await t.outbox()).toMatchObject([{ kind: "note", state: "failed" }]);
    expect(await t.cards("slack.not_sent")).toEqual([]);
  });

  it("doesn't go once you've turned members off", async () => {
    await noteQueued();
    await setSetting(t.h.tdb.db, "slack.bot.membersOn", false);
    await t.send();
    expect(t.s.posts).toEqual([]);
    expect(await t.cards("slack.not_sent")).toEqual([]);
  });

  it("still goes otherwise", async () => {
    await noteQueued();
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual([expect.stringMatching(/^I'm paused/)]);
  });

  it("still goes in your own DM with members off: it isn't to a member", async () => {
    await setSetting(t.h.tdb.db, "slack.bot.membersOn", false);
    const now = t.h.clock.now();
    await t.h.tdb.db.insert(slackOutbox).values({
      id: newId(),
      dedupeKey: "owner:got:1.000001",
      teamId: "T1",
      channelId: "DUME",
      text: "Got it, it's in Hearth.",
      kind: "note",
      createdBy: PRINCIPAL.owner,
      createdAt: now,
      notBefore: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual(["Got it, it's in Hearth."]);
  });
});
