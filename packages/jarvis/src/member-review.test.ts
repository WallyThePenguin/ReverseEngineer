// A member's reply that waits for your yes (D62, D58): the card holds the exact text, your yes
// sends it once, your no sends nothing, and a newer held reply replaces the older one. Approving
// it starts no Jarvis turn: the reply was the member's, and it's done. What you change while a
// turn answers counts when its answer goes, and again when the outbox sends it; a reply that never
// went isn't carried on from, nor put to the next turn as said.
import { approval, notification } from "@hearth/db";
import { ownerCaller, setSetting } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemberTest, memberTest, SAM, SAM_DM } from "./member-testing.ts";

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
const replies = () => t.h.tdb.db.select().from(approval).where(eq(approval.action, "slack.reply"));
const cardOf = async (approvalId: string) =>
  (await t.h.tdb.db.select().from(notification).where(eq(notification.approvalId, approvalId)))[0];
const decide = (id: string, d: "approve" | "deny") =>
  t.h.kernel.decideApproval(id, d, ownerCaller());

describe("a reply on review", () => {
  beforeEach(() => t.setSam({ replies: "review" }));

  it("waits on a card with its exact text, and your yes sends it once", async () => {
    const answer = "Tuesday at 3 works.\n\nShe'll confirm by email.";
    await ask("Can we meet Tuesday?", answer);
    const [turn] = await t.turns();
    expect(turn).toMatchObject({ status: "done", outcome: "ask" });
    const [held] = await replies();
    expect(held).toMatchObject({ status: "pending", requestedBy: turn!.context.member });
    const card = await cardOf(held!.id);
    expect(card!.title).toBe(
      "Sam Lee on Slack asks: Reply as Jarvis to Sam Lee (USAM) in their DM with Jarvis",
    );
    // All of what would go, then why it waits.
    expect(card!.body).toBe(`${answer}\n\nReplies to Sam Lee wait for your yes.`);
    expect((await t.inbound()).map((r) => r.outcome)).toEqual(["held"]);
    // Nothing goes out while it waits, however often the loop runs.
    await t.tick();
    await t.send();
    expect(t.s.posts).toEqual([]);

    expect(await decide(held!.id, "approve")).toMatchObject({ status: "ok" });
    expect(await decide(held!.id, "approve")).toMatchObject({ status: "error", code: "conflict" });
    await t.send();
    expect(t.s.posts).toEqual([expect.objectContaining({ channel: SAM_DM, text: answer })]);
    expect((await t.inbound()).map((r) => r.outcome)).toEqual(["answered"]);
    // Your yes starts no turn of Jarvis's: the member's turn is over.
    await t.h.settle();
    expect(t.h.brain.requests).toHaveLength(1);
  });

  it("sends nothing when you say no", async () => {
    await ask("Is the budget approved?", "Yes, it's approved.");
    const [held] = await replies();
    await decide(held!.id, "deny");
    expect((await replies())[0]).toMatchObject({ status: "denied" });
    await t.tick();
    await t.send();
    expect(t.s.posts).toEqual([]);
    expect(await t.outbox()).toEqual([]);
  });

  it("is replaced by a newer one in the same conversation", async () => {
    await ask("Lunch Friday?", "Friday lunch is free.");
    t.h.clock.advance(5 * 60_000);
    await ask("Actually, Thursday?", "Thursday lunch is free too.");
    const [older, newer] = (await replies()).sort((a, b) => +a.createdAt - +b.createdAt);
    expect(older).toMatchObject({ status: "expired", error: "A newer reply replaced it." });
    expect((await cardOf(older!.id))!.state).toBe("done");
    expect(newer).toMatchObject({ status: "pending" });
    expect(await decide(older!.id, "approve")).toMatchObject({ status: "error" });
    expect(await decide(newer!.id, "approve")).toMatchObject({ status: "ok" });
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual(["Thursday lunch is free too."]);
  });

  it("isn't sent when you've blocked them since", async () => {
    await ask("Can I see the roadmap?", "Here it is.");
    const [held] = await replies();
    await t.setSam({ tier: "blocked" });
    expect(await decide(held!.id, "approve")).toMatchObject({ status: "error", code: "forbidden" });
    await t.send();
    expect(t.s.posts).toEqual([]);
  });
});

it("waits for your yes in a DM too when Jarvis doesn't answer members on its own", async () => {
  await t.ok("slack.bot_settings", { answersOnOwn: false });
  await ask("Hi", "Hello Sam.");
  const [held] = await replies();
  expect(held).toMatchObject({
    status: "pending",
    reason: "A reply to a Slack member waits for your yes.",
  });
  await t.send();
  expect(t.s.posts).toEqual([]);
});

describe("what changes while it answers", () => {
  async function meanwhile(change: () => Promise<unknown>, answer: string) {
    t.h.brain.next(async () => {
      await change();
      return [{ say: answer }];
    });
    await t.write(SAM, "Can we talk Thursday?");
    await t.tick();
    await t.drain();
  }

  it("holds the answer for your yes when you pause Jarvis meanwhile", async () => {
    await meanwhile(() => setSetting(t.h.tdb.db, "jarvis.paused", true), "Thursday works.");
    const [held] = await replies();
    expect(held).toMatchObject({ status: "pending" });
    expect((await cardOf(held!.id))!.body).toBe(
      "Thursday works.\n\nJarvis was paused while it answered, so this waits for your yes.",
    );
    await t.send();
    expect(t.s.posts).toEqual([]);
    // Your yes sends it, paused or not: you read it.
    expect(await decide(held!.id, "approve")).toMatchObject({ status: "ok" });
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual(["Thursday works."]);
  });

  it("holds it, and starts afresh after, when you lower their tier meanwhile", async () => {
    await t.setSam({ tier: "schedule" });
    await meanwhile(() => t.setSam({ tier: "relay" }), "Ana is free Thursday at 3.");
    const [held] = await replies();
    expect((await cardOf(held!.id))!.body).toBe(
      "Ana is free Thursday at 3.\n\nYou changed what Sam Lee may be told while it answered, so this waits for your yes.",
    );
    await t.send();
    expect(t.s.posts).toEqual([]);
    await ask("And Friday?", "I'll pass that on.");
    // Not the session that had schedule's tools in it.
    expect(t.h.brain.requests[1]!.sessionId).toBeNull();
  });

  it("holds it when you put them on review meanwhile", async () => {
    await meanwhile(() => t.setSam({ replies: "review" }), "Thursday works.");
    const [held] = await replies();
    expect((await cardOf(held!.id))!.body).toBe(
      "Thursday works.\n\nReplies to Sam Lee wait for your yes.",
    );
    await t.send();
    expect(t.s.posts).toEqual([]);
  });

  it("sends nothing when you block them meanwhile, and passes nothing on", async () => {
    await meanwhile(() => t.setSam({ tier: "blocked" }), "Thursday works.");
    expect(await replies()).toEqual([]);
    await t.send();
    expect(t.s.posts).toEqual([]);
    expect(await t.outbox()).toEqual([]);
    // The next round turns them away as blocked: no apology, nothing in your inbox.
    await t.tick();
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual([
      expect.stringMatching(/^I can't take messages from you/),
    ]);
    expect(await t.cards("slack.member")).toEqual([]);
    expect((await t.inbound()).map((r) => r.outcome)).toEqual(["blocked"]);
  });
});

describe("an answer waiting to go", () => {
  it("doesn't go to someone you've blocked since, and you're told", async () => {
    await ask("Hi", "Hello Sam.");
    await t.setSam({ tier: "blocked" });
    await t.send();
    expect(t.s.posts).toEqual([]);
    expect(await t.outbox()).toMatchObject([
      { kind: "answer", state: "failed", error: "You've blocked them since it was written." },
    ]);
    const [card] = await t.cards("slack.not_sent");
    expect(card!.title).toBe("Jarvis's Slack message to Sam Lee didn't go out");
  });

  it("doesn't go on its own once you've paused Jarvis", async () => {
    await ask("Hi", "Hello Sam.");
    await setSetting(t.h.tdb.db, "jarvis.paused", true);
    await t.send();
    expect(t.s.posts).toEqual([]);
    expect(await t.outbox()).toMatchObject([
      { state: "failed", error: "Jarvis was paused before it went out." },
    ]);
  });
});

describe("their DM's session", () => {
  it("starts afresh after you said no to its last reply", async () => {
    await t.setSam({ replies: "review" });
    await ask("Is the budget approved?", "Yes, it's approved.");
    const [held] = await replies();
    await decide(held!.id, "deny");
    t.h.clock.advance(60 * 60_000);
    await ask("And the new hire?", "I'll pass that on.");
    const req = t.h.brain.requests[1]!;
    // Not the session that has "Yes, it's approved." as if it had been sent, nor a recap that does.
    expect(req.sessionId).toBeNull();
    expect(req.prompt).toContain("Is the budget approved?");
    expect(req.prompt).not.toContain("Yes, it's approved.");
  });

  it("isn't carried on from while its reply waits for your yes, which a newer one replaces", async () => {
    t.h.brain.next(async () => {
      await setSetting(t.h.tdb.db, "jarvis.paused", true);
      return [{ say: "Thursday works." }];
    });
    await t.write(SAM, "Can we talk Thursday?");
    await t.tick();
    await t.drain();
    await setSetting(t.h.tdb.db, "jarvis.paused", false);
    t.h.clock.advance(60_000);
    await ask("Hello?", "Hi Sam.");
    const req = t.h.brain.requests[1]!;
    expect(req.sessionId).toBeNull();
    expect(req.prompt).toContain("Can we talk Thursday?");
    expect(req.prompt).not.toContain("Thursday works.");
    // The newer reply went on its own, so the older one can't be approved to go after it.
    const [held] = await replies();
    expect(held).toMatchObject({ status: "expired", error: "A newer reply went out instead." });
    expect((await cardOf(held!.id))!.state).toBe("done");
    // And what it answered is settled, in the same go.
    expect((await t.inbound()).at(-1)!.outcome).toBe("answered");
  });

  it("starts afresh, from the recap, once you change their tier", async () => {
    await ask("Hi, it's Sam", "Hello Sam.");
    t.h.clock.advance(60_000);
    await ask("Are you there?", "Still here.");
    expect(t.h.brain.requests[1]!.sessionId).toBe("scripted-session");
    await t.setSam({ tier: "schedule" });
    await ask("When is Ana free?", "Tuesday afternoon.");
    const req = t.h.brain.requests[2]!;
    expect(req.sessionId).toBeNull();
    // What went out is in the recap, as said.
    expect(req.prompt).toContain("Hi, it's Sam");
    expect(req.prompt).toContain("Still here.");
    // Setting what's already set changes nothing.
    t.h.clock.advance(60_000);
    await t.setSam({ tier: "schedule" });
    await ask("And Wednesday?", "Wednesday morning.");
    expect(t.h.brain.requests[3]!.sessionId).toBe("scripted-session");
  });
});
