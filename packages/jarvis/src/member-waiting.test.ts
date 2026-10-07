// A post to a member checked once more as the outbox sends it (D62). An answer that went on its
// own doesn't go once you've lowered their tier or put their replies on review while it waited,
// and you're told why, with its text; one you said yes to still goes. A fixed note doesn't go to
// someone you've blocked since, or with members off, and nobody needs telling.
import { approval } from "@hearth/db";
import { ownerCaller, setSetting } from "@hearth/kernel";
import { eq } from "drizzle-orm";
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

  it("doesn't go once you've put their replies on review", async () => {
    await ask("Hi", "Hello Sam.");
    await t.setSam({ replies: "review" });
    await t.send();
    expect(t.s.posts).toEqual([]);
    expect(await t.outbox()).toMatchObject([
      { state: "failed", error: "You set replies to them to wait for your yes while this waited." },
    ]);
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
});
