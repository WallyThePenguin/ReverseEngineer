// A reminder outside content set is still its words wherever it's read back: listing reminders
// or reading Hearth's status makes the turn untrusted, and the status never repeats them. An
// untrusted turn calls off only what its own conversation set, and what the owner asks for in a
// conversation that read an email is never counted against outside content's cap.
import { conversation, jarvisTurn } from "@hearth/db";
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

  it("makes your turn untrusted when it reads Hearth's status, which doesn't repeat it", async () => {
    await remind({ text: "Call Sam", at: "15:00" });
    await plant();
    const status = await h.kernel.execute<{
      schedules: { label?: string | null; outside?: boolean }[];
    }>("system.status", {}, ownerCaller());
    if (status.status !== "ok") throw new Error(JSON.stringify(status));
    expect(status.result.schedules.filter((s) => s.label)).toMatchObject([
      { label: "Reminder: Call Sam", outside: false },
      { label: "Reminder (set from an email or a message)", outside: true },
    ]);
    expect(JSON.stringify(status.result)).not.toContain("pay.example");
    expect(await taintedBy("system_status")).toBe(true);
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

  it("never reaches what you asked for in another conversation that read an email", async () => {
    const turnId = await yourTurn();
    const yours = await remind(
      { text: "Call Sam", at: "15:00" },
      jarvisCaller("untrusted", { turnId, conversationId: newId() }),
    );
    expect(await cancel(yours.id, fromMail())).toMatchObject({ code: "forbidden" });
    expect(await cancel(yours.id, ownerCaller())).toMatchObject({ status: "ok" });
  });
});

/** A turn you started by asking, in a conversation that had read an email: the turn is yours. */
async function yourTurn() {
  const id = newId();
  await h.tdb.db.insert(jarvisTurn).values({
    id,
    trigger: "chat",
    mode: "reactive",
    lane: "fast",
    origin: "owner",
    prompt: "remind me at 3 to call Sam",
  });
  return id;
}

describe("the cap on what outside content sets", () => {
  it("never counts or refuses what you asked for in a conversation that read an email", async () => {
    for (let n = 0; n < OUTSIDE_REMINDERS.all - 1; n++) await plant();
    const asked = jarvisCaller("untrusted", { turnId: await yourTurn(), conversationId: newId() });
    for (let n = 0; n <= OUTSIDE_REMINDERS.each; n++)
      await remind({ text: `Call Sam ${n}`, at: "15:00" }, asked);
    // Yours took none of outside content's places: its last one is still there.
    await plant();
    await expect(plant()).rejects.toThrow(/Enough reminders/);
  });

  it("still counts what Jarvis set on its own from outside content", async () => {
    const heartbeat = await yourTurn();
    await h.tdb.db
      .update(jarvisTurn)
      .set({ origin: "untrusted", trigger: "routine" })
      .where(eq(jarvisTurn.id, heartbeat));
    const caller = jarvisCaller("untrusted", { turnId: heartbeat });
    for (let n = 0; n < OUTSIDE_REMINDERS.each; n++) await plant(caller);
    await expect(plant(caller)).rejects.toThrow(/Enough reminders/);
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
