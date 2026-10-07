// "Always allow" (D70): a card for a Slack send Jarvis asked for in a conversation you started
// offers a rule as narrow as the card, for that one channel or person, and the next send there
// goes at once. A card from a turn that read outside content never offers it, can't make the
// rule, and the rule never lets such a turn through. Email always waits for you.
import { approval } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
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
/** Your rules for posting in channels. */
const posting = async () =>
  (await k.ok<{ id: string; action: string }[]>("standing_rule.list")).filter(
    (r) => r.action === "slack.post_in_channel",
  );
const always = (approvalId: string) =>
  k.run("standing_rule.always_allow", { approvalId }, ownerCaller());

describe("Always allow", () => {
  it("covers the card's one channel, and the next post there goes at once", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    expect(await offered(id)).toBe("posting in #general");
    expect(await always(id)).toMatchObject({
      status: "ok",
      result: { action: "slack.post_in_channel", target: "CGEN", note: "posting in #general" },
    });
    expect(await k.t.kernel.decideApproval(id, "approve", ownerCaller())).toMatchObject({
      status: "ok",
    });
    expect(await k.rows()).toHaveLength(1);

    const next = { ...postGeneral, text: "Standup is back at 9.", threadTs: "1700000000.000100" };
    expect(await k.run("slack.post_in_channel", next, yours)).toMatchObject({ status: "ok" });
    expect(await k.rows()).toHaveLength(2);
    // Removed in Settings, it asks again.
    const [rule] = await posting();
    await k.ok("standing_rule.delete", { id: rule!.id });
    await ask("slack.post_in_channel", { ...postGeneral, text: "Lunch at 12." });
  });

  it("covers the card's one person, not everyone", async () => {
    const id = await ask("slack.dm", tellSam);
    expect(await offered(id)).toBe("messaging Sam Lee on Slack");
    await always(id);
    expect(await k.run("slack.dm", { ...tellSam, text: "Ship it." }, yours)).toMatchObject({
      status: "ok",
    });
    await ask("slack.dm", tellGus);
  });

  it("isn't offered on a card from outside content, and can't be made from one", async () => {
    const id = await ask("slack.post_in_channel", postGeneral, fromMail);
    expect(await offered(id)).toBeNull();
    expect(await always(id)).toMatchObject({ status: "error", code: "forbidden" });
    // Nor on a routine's card: only a conversation you started.
    const routine = await ask("slack.dm", tellSam, jarvisCaller("system"));
    expect(await offered(routine)).toBeNull();
    expect(await always(routine)).toMatchObject({ status: "error", code: "forbidden" });
    expect(await k.t.tdb.db.select().from(approval).where(eq(approval.id, id))).toMatchObject([
      { status: "pending" },
    ]);
  });

  it("isn't offered once an email asks for the same thing, and never lets such a turn through", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    // The same request, from a turn that read an email: the card is as cautious as its asker.
    expect(await ask("slack.post_in_channel", postGeneral, fromMail)).toBe(id);
    expect(await offered(id)).toBeNull();
    expect(await always(id)).toMatchObject({ status: "error", code: "forbidden" });

    const mine = await ask("slack.post_in_channel", { ...postGeneral, text: "Lunch at 12." });
    await always(mine);
    await ask("slack.post_in_channel", { ...postGeneral, text: "Payroll moved." }, fromMail);
    expect(await k.rows()).toEqual([]);
  });

  it("never covers email", () => {
    expect(k.t.kernel.registry.action("mail.send")?.alwaysAllow).toBeUndefined();
  });

  it("is only yours to press", async () => {
    const id = await ask("slack.post_in_channel", postGeneral);
    expect(await k.run("standing_rule.always_allow", { approvalId: id }, yours)).toMatchObject({
      status: "denied",
    });
    expect(await posting()).toEqual([]);
  });
});
