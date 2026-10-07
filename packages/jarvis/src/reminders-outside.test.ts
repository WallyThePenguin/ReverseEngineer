// A reminder outside content set is still its words wherever it's read back: listing reminders
// or reading Hearth's status makes the turn untrusted, and the status never repeats them. An
// untrusted turn calls off only what its own conversation set, and what the owner asks for in a
// conversation that read an email is never counted against outside content's cap (whether a turn
// is the owner asking is decided as it runs: reminders-asked.test.ts).
import { conversation, schedule } from "@hearth/db";
import { type Caller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { OUTSIDE_REMINDERS } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
});
afterEach(() => h.destroy());

const fromMail = (conversationId = newId()) => jarvisCaller("untrusted", { conversationId });
async function remind(input: Record<string, unknown>, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<{ id: string }>("reminder.create", input, caller);
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
}
const plant = (caller = fromMail()) =>
  remind({ text: "Open https://pay.example/now", at: "16:00" }, caller);

/** Whether a turn of yours, in a new conversation, ends untrusted after calling `tool`. */
async function taintedBy(tool: string) {
  h.brain.next([{ call: tool, input: {} }, { say: "Here's what's coming up." }]);
  const res = await h.kernel.execute<{ conversationId: string }>(
    "chat.send",
    { text: "what's coming up?" },
    ownerCaller(),
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  await h.settle();
  const [c] = await h.tdb.db
    .select()
    .from(conversation)
    .where(eq(conversation.entityId, res.result.conversationId));
  return c!.taintedAt !== null;
}

describe("a reminder outside content set, read back", () => {
  it("makes your turn untrusted when it lists reminders", async () => {
    await plant();
    expect(await taintedBy("reminder_list")).toBe(true);
  });

  it("isn't in Hearth's status, so reading that leaves your turn as it was", async () => {
    await remind({ text: "Call Sam", at: "15:00" });
    await plant();
    const status = await h.kernel.execute<{ schedules: { id: string }[] }>(
      "system.status",
      {},
      ownerCaller(),
    );
    if (status.status !== "ok") throw new Error(JSON.stringify(status));
    expect(status.result.schedules.filter((s) => s.id.startsWith("reminder:"))).toEqual([]);
    expect(JSON.stringify(status.result)).not.toContain("pay.example");
    expect(await taintedBy("system_status")).toBe(false);
  });

  it("leaves your turn trusted when every reminder is yours", async () => {
    await remind({ text: "Call Sam", at: "15:00" });
    expect(await taintedBy("reminder_list")).toBe(false);
    expect(await taintedBy("system_status")).toBe(false);
  });
});

describe("calling one off after reading outside content", () => {
  const cancel = (id: string, caller: Caller) =>
    h.kernel.execute("reminder.cancel", { id }, caller);

  it("works only from the conversation that set it", async () => {
    const here = newId();
    const planted = await plant(fromMail(here));
    expect(await cancel(planted.id, fromMail())).toMatchObject({ code: "forbidden" });
    expect(await cancel(planted.id, jarvisCaller("untrusted"))).toMatchObject({
      code: "forbidden",
    });
    expect(await cancel(planted.id, fromMail(here))).toMatchObject({ status: "ok" });
  });

  it("never reaches what you asked for, even from the conversation you asked in", async () => {
    const here = newId();
    const yours = await remind({ text: "Call Sam", at: "15:00" }, asking(here));
    expect(await cancel(yours.id, fromMail())).toMatchObject({ code: "forbidden" });
    expect(await cancel(yours.id, fromMail(here))).toMatchObject({ code: "forbidden" });
    expect(await cancel(yours.id, ownerCaller())).toMatchObject({ status: "ok" });
  });
});

/** Your ask, in a conversation that had read an email: Jarvis's turn says so as it runs. */
const asking = (conversationId = newId()) =>
  jarvisCaller("untrusted", { conversationId, asked: true });

describe("the cap on what outside content sets", () => {
  it("never counts or refuses what you asked for in a conversation that read an email", async () => {
    for (let n = 0; n < OUTSIDE_REMINDERS.all - 1; n++) await plant();
    const asked = asking();
    for (let n = 0; n <= OUTSIDE_REMINDERS.each; n++)
      await remind({ text: `Call Sam ${n}`, at: "15:00" }, asked);
    // Yours took none of outside content's places: its last one is still there.
    await plant();
    await expect(plant()).rejects.toThrow(/Enough reminders/);
  });

  it("still counts what Jarvis set on its own from outside content", async () => {
    const caller = jarvisCaller("untrusted", { turnId: newId() });
    for (let n = 0; n < OUTSIDE_REMINDERS.each; n++) await plant(caller);
    await expect(plant(caller)).rejects.toThrow(/Enough reminders/);
  });

  it("takes an outside agent's word for nothing: only Jarvis's turn says you asked", async () => {
    const mcp = { ...asking(), principal: "mcp:claude" };
    for (let n = 0; n < OUTSIDE_REMINDERS.each; n++) await plant(mcp);
    await expect(plant(mcp)).rejects.toThrow(/Enough reminders/);
  });

  it("counts the ones set from outside content before this, which didn't say who set them", async () => {
    const here = newId();
    // As the first reminders (#89) were kept: vouched false, no by, origin or asked.
    for (let n = 0; n < OUTSIDE_REMINDERS.each; n++)
      await h.tdb.db.insert(schedule).values({
        id: `reminder:${newId()}`,
        kind: "reminder",
        nextRunAt: new Date("2026-10-01T19:00:00Z"),
        timeZone: "America/New_York",
        payload: { reminder: newId(), text: "Pay now", vouched: false, from: here },
      });
    await expect(plant(fromMail(here))).rejects.toThrow(/Enough reminders/);
  });
});

describe("one you asked for in a conversation that read an email", () => {
  it("is listed as yours, and still as set after reading outside content", async () => {
    await remind({ text: "Pay https://pay.example", at: "15:00" }, asking());
    const list = await h.kernel.execute("reminder.list", {}, ownerCaller());
    expect(list).toMatchObject({ result: [{ asked: true, setAfterOutsideContent: true }] });
  });
});

describe("an exact time", () => {
  it("must be a real day and time, and said a moment late means now", async () => {
    for (const at of ["2027-02-30T10:00:00-05:00", "2026-10-01T24:00:00Z", "2026-10-01T10:60Z"]) {
      const res = await h.kernel.execute(
        "reminder.create",
        { text: "Call Sam", at },
        ownerCaller(),
      );
      expect(res).toMatchObject({ status: "error", code: "invalid_input" });
    }
    expect(await remind({ text: "Call Sam", at: "2026-10-01T13:59:30Z" })).toMatchObject({
      at: "2026-10-01T14:00:00.000Z",
    });
  });
});
