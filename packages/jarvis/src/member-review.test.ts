// A member's reply that waits for your yes (D62, D58): the card holds the exact text, your yes
// sends it once, your no sends nothing, and a newer held reply replaces the older one. Approving
// it starts no Jarvis turn: the reply was the member's, and it's done.
import { approval, notification } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
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
