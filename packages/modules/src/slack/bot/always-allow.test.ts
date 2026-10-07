// "Always allow" (D70): a card for a Slack send Jarvis asked for in a conversation you started
// offers a rule as narrow as the card, for that one channel or person. Pressing it says yes and
// writes the rule together, so a yes that's refused, runs out or fails leaves no rule, and the
// next send there goes at once. A card from a turn that read outside content never offers it,
// can't make the rule, and the rule never lets such a turn through. Email always waits for you.
import { approval, audit, principal } from "@hearth/db";
import { type Caller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SendTest, sendTest } from "./outbox-testing.ts";

let k: SendTest;
beforeEach(async () => {
  k = await sendTest();
});
afterEach(() => k.t.destroy());

const yours = jarvisCaller("owner");
const fromMail = jarvisCaller("untrusted");
const postGeneral = { channelId: "CGEN", text: "Standup moved to 10." };
const tellSam = { to: "USAM", text: "The build is fixed." };
const tellGus = { to: "UGUS", text: "The build is fixed." };

/** Asks as `caller`; gives back the approval's id. */
async function ask(action: string, input: unknown, caller: Caller = yours) {
  const res = await k.run(action, input, caller);
  expect(res).toMatchObject({ status: "pending_approval" });
  return (res as { approvalId: string }).approvalId;
}
/** What the card's Always allow says in the inbox, or null if it offers none. */
async function offered(approvalId: string) {
  const rows =
    await k.ok<{ notification: { approvalId: string | null }; alwaysAllow: string }[]>(
      "inbox.list",
    );
  return rows.find((r) => r.notification.approvalId === approvalId)?.alwaysAllow ?? null;
}
/** Jarvis's own rules, as Settings lists them (not the one its Slack bot holds for members). */
const rules = async () =>
  (
    await k.ok<
      { id: string; action: string; principal: string; target: string | null; note: string }[]
    >("standing_rule.list")
  ).filter((r) => r.principal === "jarvis");
const always = (approvalId: string, caller: Caller = ownerCaller()) =>
  k.t.kernel.decideApproval(approvalId, "approve", caller, { alwaysAllow: true });
const statusOf = async (id: string) =>
  (await k.t.tdb.db.select().from(approval).where(eq(approval.id, id)))[0]?.status;
/** What the audit kept of each Always allow, given or refused. */
const allowed = async () =>
  (
    await k.t.tdb.db
      .select()
      .from(audit)
      .where(eq(audit.action, "standing_rule.always_allow"))
      .orderBy(audit.at)
  ).map((a) => ({ by: a.principal, outcome: a.outcome, approvalId: a.approvalId, input: a.input }));
const generalRule = {
  action: "slack.post_in_channel",
  target: "CGEN",
  note: "posting in #general",
};
/** Waits until a query in this test's database is waiting on a row lock. */
async function waitingOnLock() {
  for (let i = 0; i < 500; i++) {
    const res = await k.t.tdb.db.execute(
      sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (res.rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Nothing waited on the card's lock.");
}

describe("Always allow", () => {
  it("says yes and covers the card's one channel, so the next post there goes at once", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    expect(await offered(id)).toBe("posting in #general");
    expect(await always(id)).toMatchObject({ status: "ok" });
    expect(await statusOf(id)).toBe("executed");
    expect(await rules()).toMatchObject([
      { action: "slack.post_in_channel", target: "CGEN", note: "posting in #general" },
    ]);
    expect(await k.rows()).toHaveLength(1);

    const next = { ...postGeneral, text: "Standup is back at 9.", threadTs: "1700000000.000100" };
    expect(await k.run("slack.post_in_channel", next, yours)).toMatchObject({ status: "ok" });
    expect(await k.rows()).toHaveLength(2);
    // Removed in Settings, it asks again.
    const [rule] = await rules();
    await k.ok("standing_rule.delete", { id: rule!.id });
    await ask("slack.post_in_channel", { ...postGeneral, text: "Lunch at 12." });
  });

  it("covers the card's one person, not everyone", async () => {
    const id = await ask("slack.dm", tellSam);
    expect(await offered(id)).toBe("messaging Sam Lee on Slack");
    expect(await always(id)).toMatchObject({ status: "ok" });
    expect(await k.run("slack.dm", { ...tellSam, text: "Ship it." }, yours)).toMatchObject({
      status: "ok",
    });
    await ask("slack.dm", tellGus);
  });

  it("leaves no rule when the yes is turned away, runs out, or what it sends changed", async () => {
    // Decided on another device first.
    const decided = await ask("slack.post_in_channel", postGeneral);
    await k.t.kernel.decideApproval(decided, "deny", ownerCaller());
    expect(await always(decided)).toMatchObject({ status: "error", code: "conflict" });
    // Ran out before you pressed it.
    const late = await ask("slack.dm", tellSam);
    await k.t.tdb.db
      .update(approval)
      .set({ expiresAt: new Date(k.t.clock.now().getTime() - 1000) })
      .where(eq(approval.id, late));
    expect(await always(late)).toMatchObject({ status: "error", code: "conflict" });
    // Someone joined #general since it asked: nothing goes out, so nothing is allowed either.
    const changed = await ask("slack.post_in_channel", { ...postGeneral, text: "Lunch at 12." });
    k.s.channel("CGEN", "general", ["UME", "USAM", "UGUS", "UJARVIS", "UNEW"]);
    expect(await always(changed)).toMatchObject({ status: "error", code: "conflict" });
    expect(await statusOf(changed)).toBe("failed");

    expect(await rules()).toEqual([]);
    expect(await k.rows()).toEqual([]);
  });

  it("isn't offered on a card from outside content, and does nothing there", async () => {
    const id = await ask("slack.post_in_channel", postGeneral, fromMail);
    expect(await offered(id)).toBeNull();
    expect(await always(id)).toMatchObject({ status: "denied" });
    // Nor on a routine's card: only a conversation you started.
    const routine = await ask("slack.dm", tellSam, jarvisCaller("system"));
    expect(await offered(routine)).toBeNull();
    expect(await always(routine)).toMatchObject({ status: "denied" });
    // Neither was said yes to: both still wait for you.
    expect([await statusOf(id), await statusOf(routine)]).toEqual(["pending", "pending"]);
    expect(await rules()).toEqual([]);
    expect(await k.rows()).toEqual([]);
  });

  it("isn't offered once an email asks for the same thing, and never lets such a turn through", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    // The same request, from a turn that read an email: the card is as cautious as its asker.
    expect(await ask("slack.post_in_channel", postGeneral, fromMail)).toBe(id);
    expect(await offered(id)).toBeNull();
    expect(await always(id)).toMatchObject({ status: "denied" });
    expect(await statusOf(id)).toBe("pending");

    const mine = await ask("slack.post_in_channel", { ...postGeneral, text: "Lunch at 12." });
    expect(await always(mine)).toMatchObject({ status: "ok" });
    // The rule is there, and the turn that read an email still asks.
    expect(await rules()).toMatchObject([{ target: "CGEN" }]);
    await ask("slack.post_in_channel", { ...postGeneral, text: "Payroll moved." }, fromMail);
    expect(await k.rows()).toHaveLength(1);
  });

  it("leaves a rule for any target, written in Settings, covering every target, once", async () => {
    await k.ok("standing_rule.create", { action: "slack.dm", note: "Tell people things" });
    await k.ok("standing_rule.create", { action: "slack.dm", note: "Tell anyone" });
    expect((await rules()).filter((r) => r.action === "slack.dm")).toMatchObject([
      { target: null, note: "Tell anyone" },
    ]);
    expect(await k.run("slack.dm", tellSam, yours)).toMatchObject({ status: "ok" });
    expect(await k.run("slack.dm", tellGus, yours)).toMatchObject({ status: "ok" });
  });

  it("never covers email, or what another agent asked, whatever the card says", async () => {
    expect(k.t.kernel.registry.action("mail.send")?.alwaysAllow).toBeUndefined();
    const card = async (action: string, requestedBy: string) => {
      const id = newId();
      await k.t.tdb.db.insert(approval).values({
        id,
        action,
        input: {},
        inputHash: "x",
        risk: "outward",
        summary: "Asks",
        reason: "Asks",
        requestedBy,
        origin: "owner",
        alwaysAllow: { target: "USAM", says: "telling Sam" },
      });
      return id;
    };
    await k.t.tdb.db
      .insert(principal)
      .values({ id: "mcp:claude", kind: "mcp_client", displayName: "Claude" })
      .onConflictDoNothing();
    for (const id of [await card("mail.send", "jarvis"), await card("slack.dm", "mcp:claude")]) {
      expect(await always(id)).toMatchObject({ status: "denied" });
      expect(await statusOf(id)).toBe("pending");
    }
    expect(await rules()).toEqual([]);
  });

  it("is only yours to press, on your own screens", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    expect(await always(id, yours)).toMatchObject({ status: "denied" });
    // A paired device's yes is untrusted: it can say yes, but not give a standing one.
    const device = ownerCaller("device", { origin: "untrusted" });
    expect(await always(id, device)).toMatchObject({ status: "denied" });
    expect(await statusOf(id)).toBe("pending");
    expect(await rules()).toEqual([]);
  });

  it("answers with the rule it saved, and the audit keeps who allowed it from which card", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    expect(await always(id)).toEqual({ status: "ok", result: { rule: generalRule } });
    const input = { approvalId: id, action: "slack.post_in_channel", target: "CGEN" };
    expect(await allowed()).toEqual([{ by: "owner", outcome: "ok", approvalId: id, input }]);
    const resolved = async (approvalId: string) =>
      (await k.t.events("approval.resolved")).find((e) => e.payload.approvalId === approvalId)
        ?.payload;
    expect(await resolved(id)).toMatchObject({ decision: "approved", alwaysAllow: true });
    // A plain yes isn't one, and writes no audit row of its own.
    const plain = await ask("slack.dm", tellSam);
    await k.t.kernel.decideApproval(plain, "approve", ownerCaller());
    expect(await resolved(plain)).not.toHaveProperty("alwaysAllow");
    // A refusal is kept too.
    const mail = await ask("slack.dm", tellGus, fromMail);
    expect(await always(mail)).toMatchObject({ status: "denied" });
    expect((await allowed()).map((a) => [a.outcome, a.approvalId])).toEqual([
      ["ok", id],
      ["denied", mail],
    ]);
  });

  it("says it's done, rule and all, when pressed again after its answer was lost", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    expect(await always(id)).toMatchObject({ status: "ok" });
    // The answer never reached you, so you press it again: nothing goes out twice.
    expect(await always(id)).toEqual({
      status: "ok",
      result: { rule: generalRule, already: true },
    });
    expect(await k.rows()).toHaveLength(1);
    expect(await allowed()).toHaveLength(1);
    // A plain yes elsewhere saved no rule, so pressing Always allow after it says so.
    const plain = await ask("slack.dm", tellSam);
    await k.t.kernel.decideApproval(plain, "approve", ownerCaller());
    expect(await always(plain)).toMatchObject({ status: "error", code: "conflict" });
    // A card you said no to stays a no, though #general has its rule now.
    const denied = newId();
    await k.t.tdb.db.insert(approval).values({
      id: denied,
      action: "slack.post_in_channel",
      input: {},
      inputHash: "x",
      risk: "outward",
      summary: "Asks",
      reason: "Asks",
      requestedBy: "jarvis",
      origin: "owner",
      status: "denied",
      alwaysAllow: { target: "CGEN", says: "posting in #general" },
    });
    expect(await always(denied)).toMatchObject({ status: "error", code: "conflict" });
    // Nor once you've removed the rule in Settings.
    const [rule] = await rules();
    await k.ok("standing_rule.delete", { id: rule!.id });
    expect(await always(id)).toMatchObject({ status: "error", code: "conflict" });
  });

  it("does nothing when an email's turn asks for the same thing while you press it", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    // That turn's copy lowers the card after your press read it, before the press claims it.
    let locked!: () => void;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      locked = r;
    });
    const done = new Promise<void>((r) => {
      release = r;
    });
    const lowering = k.t.tdb.db.transaction(async (tx) => {
      await tx.update(approval).set({ origin: "untrusted" }).where(eq(approval.id, id));
      locked();
      await done;
    });
    await held;
    const pressed = always(id);
    await waitingOnLock();
    release();
    await lowering;
    expect(await pressed).toMatchObject({ status: "denied" });
    expect(await statusOf(id)).toBe("pending");
    expect(await rules()).toEqual([]);
    expect(await k.rows()).toEqual([]);
  });
});
