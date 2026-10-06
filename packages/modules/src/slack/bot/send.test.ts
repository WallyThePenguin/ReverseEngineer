// "Tell Sam the build is fixed" (D62): Jarvis finds who you mean and messages them, or posts in a
// channel, as its own bot. Like mail.send (D33), the card leads with who it goes to and then the
// exact text, a yes runs once (D58), a change after you were asked refuses, each send has its own
// standing rule, a turn that read outside content always asks, and outside agents can't send.
import { memberPrincipal, PRINCIPAL } from "@hearth/core";
import { approval, conversationLog, notification, principal, slackThread } from "@hearth/db";
import { type Caller, isVisibleTo, jarvisCaller, ownerCaller, setSetting } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SAM, type SendTest, sendTest } from "./outbox-testing.ts";

let k: SendTest;
beforeEach(async () => {
  k = await sendTest();
});
afterEach(() => k.t.destroy());

const trusted = jarvisCaller("agent");
const tellSam = { to: "USAM", text: "The build is fixed.\n\nShip it when you're ready." };
const postGeneral = { channelId: "CGEN", text: "Standup moved to 10." };

/** Asks as `caller`, and gives back the card it made. */
async function ask(action: string, input: unknown, caller: Caller = trusted) {
  const res = await k.run(action, input, caller);
  expect(res).toMatchObject({ status: "pending_approval" });
  const id = (res as { approvalId: string }).approvalId;
  const [row] = await k.t.tdb.db.select().from(approval).where(eq(approval.id, id));
  const [card] = await k.t.tdb.db
    .select()
    .from(notification)
    .where(eq(notification.approvalId, id));
  return { id, row: row!, card: card! };
}
const yes = (id: string) => k.t.kernel.decideApproval(id, "approve", ownerCaller());

describe("finding who you mean", () => {
  it("by name, email or id, people only, with the person they are in Hearth", async () => {
    const sam = await k.ok<{ id: string }>("person.create", { name: "Sam Lee" });
    await k.ok("person.add_email", { id: sam.id, email: "sam@acme.example" });
    expect(await k.ok("slack.find_member", { query: "Sam" })).toEqual({
      candidates: [
        {
          id: "USAM",
          name: "Sam Lee",
          goesBy: "sam",
          email: "sam@acme.example",
          guest: false,
          personId: sam.id,
        },
      ],
      more: false,
    });
    expect(await k.ok("slack.find_member", { query: "gus@partner.example" })).toMatchObject({
      candidates: [{ id: "UGUS", guest: true }],
    });
    expect(await k.ok("slack.find_member", { query: "jarvis" })).toEqual({
      candidates: [],
      more: false,
    });
    // And a DM can go to the person: their Slack account is found by their email.
    expect(await k.ok("slack.dm", { to: sam.id, text: "hi" })).toMatchObject({ to: "Sam Lee" });
    expect((await k.rows())[0]).toMatchObject({ channelId: "USAM" });
  });
});

describe("sending as Jarvis", () => {
  it("asks with a card that leads with who it goes to, then the exact text", async () => {
    const { row, card } = await ask("slack.dm", tellSam);
    expect(row.summary).toBe(
      "Message Sam Lee (sam@acme.example, USAM) on Slack as Jarvis\n\nThe build is fixed.\n\nShip it when you're ready.",
    );
    expect(card.title).toBe(
      "Jarvis asks: Message Sam Lee (sam@acme.example, USAM) on Slack as Jarvis",
    );
    expect(card.body?.startsWith(tellSam.text)).toBe(true);
    const gus = await ask("slack.dm", { to: "UGUS", text: "hi", threadTs: "1700000000.000100" });
    expect(gus.row.summary).toBe(
      "Message Gus Guest (gus@partner.example, UGUS, a guest) on Slack as Jarvis, in a thread\n\nhi",
    );
    const channel = await ask("slack.post_in_channel", postGeneral);
    expect(channel.row.summary).toBe(
      "Post in #general (4 people, 1 of them guests) on Slack as Jarvis\n\nStandup moved to 10.",
    );
    // Nothing is queued until you say yes.
    expect(await k.rows()).toEqual([]);
  });

  it("sends once however many times you say yes (D58)", async () => {
    const { id } = await ask("slack.dm", tellSam);
    const both = await Promise.all([yes(id), yes(id)]);
    expect(both.filter((r) => r.status === "ok")).toHaveLength(1);
    expect(await k.rows()).toHaveLength(1);
    await k.round();
    expect(k.s.posts).toHaveLength(1);
    expect(await k.round()).toMatchObject({ sent: 0 });
  });

  it("refuses when who or where it goes changed after you were asked", async () => {
    const dm = await ask("slack.dm", tellSam);
    k.s.users.set("USAM", { ...SAM, email: "sam@elsewhere.example" });
    expect(await yes(dm.id)).toMatchObject({ status: "error", code: "conflict" });
    const post = await ask("slack.post_in_channel", postGeneral);
    k.s.channelFacts.get("CGEN")!.members.push("UNEW");
    expect(await yes(post.id)).toMatchObject({ status: "error", code: "conflict" });
    expect(await k.rows()).toEqual([]);
  });

  it("goes at once for a trusted turn only with that send's own standing rule", async () => {
    await ask("slack.dm", tellSam);
    await k.ok("standing_rule.create", { action: "slack.dm" });
    expect(await k.run("slack.dm", tellSam, trusted)).toMatchObject({
      status: "ok",
      result: { queued: true, to: "Sam Lee" },
    });
    expect(await k.rows()).toHaveLength(1);
    // A DM's rule doesn't post in a channel.
    await ask("slack.post_in_channel", postGeneral);
    expect(await k.rows()).toHaveLength(1);
  });

  it("asks a turn that read outside content even with a standing rule, and marks the card", async () => {
    // An email said "tell Sam X": the turn is untrusted, so nothing goes on its say-so.
    await k.ok("standing_rule.create", { action: "slack.dm" });
    const { row } = await ask("slack.dm", tellSam, jarvisCaller("untrusted"));
    expect(row.origin).toBe("untrusted");
    expect(await k.rows()).toEqual([]);
    expect(k.s.posts).toEqual([]);
  });

  it("can't be seen or used by an outside agent", async () => {
    await k.t.tdb.db
      .insert(principal)
      .values({ id: "mcp:laptop", kind: "mcp_client", displayName: "Laptop" });
    const mcp: Caller = {
      principal: "mcp:laptop",
      kind: "mcp_client",
      origin: "untrusted",
      via: "mcp",
    };
    for (const [name, input] of [
      ["slack.dm", tellSam],
      ["slack.post_in_channel", postGeneral],
      ["slack.find_member", { query: "sam" }],
    ] as const) {
      expect(isVisibleTo(k.t.kernel.registry.action(name)!, "mcp_client")).toBe(false);
      expect(await k.run(name, input, mcp)).toMatchObject({ status: "denied" });
    }
    expect(await k.t.tdb.db.select().from(approval)).toEqual([]);
    expect(await k.rows()).toEqual([]);
  });

  it("sends your own at once, and logs it in their conversation with Jarvis", async () => {
    // Sam's DM with Jarvis, as it is once Sam has written to Jarvis.
    const convo = await k.ok<{ id: string }>("conversation.create", { title: "Sam on Slack" });
    const member = memberPrincipal("T1", "USAM");
    await k.t.tdb.db
      .insert(principal)
      .values({ id: member, kind: "member", displayName: "Sam Lee" });
    await k.t.tdb.db.insert(slackThread).values({
      channelId: "DUSAM",
      teamId: "T1",
      conversationId: convo.id,
      audience: "member",
      member,
    });
    const sent = await k.ok<{ id: string }>("slack.dm", { to: "USAM", text: "Lunch at 12?" });
    const log = await k.t.tdb.db
      .select()
      .from(conversationLog)
      .where(eq(conversationLog.conversationId, convo.id));
    expect(log.map((l) => [l.kind, l.payload])).toEqual([
      ["assistant_message", { text: "Lunch at 12?", sentFor: PRINCIPAL.owner, outboxId: sent.id }],
    ]);
    // A channel post with no thread of Jarvis's there is just posted.
    await k.ok("slack.post_in_channel", postGeneral);
    expect(await k.round()).toMatchObject({ sent: 2 });
    expect(k.s.posts.map((p) => [p.channel, p.text])).toEqual([
      ["DUSAM", "Lunch at 12?"],
      ["CGEN", "Standup moved to 10."],
    ]);
  });

  it("refuses where Jarvis can't post: not invited, switched off, or not a person", async () => {
    expect(await k.run("slack.post_in_channel", { channelId: "CRAND", text: "hi" })).toMatchObject({
      status: "error",
      message: expect.stringContaining("Invite @Jarvis there first"),
    });
    expect(await k.run("slack.dm", { to: "UJARVIS", text: "hi" })).toMatchObject({
      status: "error",
      code: "invalid_input",
    });
    await setSetting(k.t.tdb.db, "slack.bot.membersOn", false);
    expect(await k.run("slack.dm", tellSam)).toMatchObject({
      status: "error",
      code: "unavailable",
    });
    // Jarvis's ask is refused before any card is made.
    expect(await k.run("slack.dm", tellSam, trusted)).toMatchObject({ status: "error" });
    expect(await k.t.tdb.db.select().from(approval)).toEqual([]);
    expect(await k.rows()).toEqual([]);
  });
});
