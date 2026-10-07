// "Remind me at 3 to call Sam", "in 2 hours": it rings at that minute, as an interrupt in the
// inbox, through quiet hours and the day's cap, since you asked for it. One Jarvis set after
// reading outside content doesn't vouch for its own time (D54): it waits, like anything else.
import { notification } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller, systemCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
afterEach(() => h.destroy());

const reminders = () =>
  h.tdb.db.select().from(notification).where(eq(notification.kind, "reminder"));
const rung = async (title: string) => (await reminders()).find((n) => n.title === title);

async function remind(input: Record<string, unknown>, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<{ at: string; when: string; note?: string }>(
    "reminder.create",
    input,
    caller,
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
}
/** Moves the clock to `at` and lets everything due happen. */
async function at(iso: string) {
  h.clock.set(iso);
  await h.settle();
}

describe("a reminder you ask for", () => {
  it("rings at the minute you said, once", async () => {
    h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
    h.brain.next([
      { call: "reminder_create", input: { text: "Call Sam", at: "15:00" } },
      { say: "I'll remind you at 3 p.m." },
    ]);
    await h.kernel.execute("chat.send", { text: "remind me at 3 to call Sam" }, ownerCaller());
    await h.settle();
    expect(h.brain.requests[0]?.tools.map((t) => t.name)).toContain("reminder_create");

    await at("2026-10-01T18:59:00Z");
    expect(await reminders()).toEqual([]);
    await at("2026-10-01T19:00:00Z"); // 3 p.m.
    const [n] = await reminders();
    expect(n).toMatchObject({ title: "Call Sam", urgency: "interrupt", body: null });
    expect(n?.deliveredAt?.toISOString()).toBe("2026-10-01T19:00:00.000Z");

    await at("2026-10-02T19:00:00Z");
    expect(await reminders()).toHaveLength(1);
  });

  it('"in 2 hours" counts real hours across midnight and when the clocks go back', async () => {
    h = await createJarvisHarness("2026-11-01T03:30:00Z"); // Saturday 11:30 p.m., EDT
    expect(await remind({ text: "Take the bread out", inMinutes: 120 })).toMatchObject({
      at: "2026-11-01T05:30:00.000Z",
      when: "2026-11-01 1:30 a.m.",
    });
    await at("2026-11-01T04:30:00Z"); // 12:30 a.m. EDT; at 2 a.m. it's 1 a.m. again
    // Past the switch: two real hours on, the clock on the wall says only one.
    expect(await remind({ text: "Check the oven", inMinutes: 120 })).toMatchObject({
      at: "2026-11-01T06:30:00.000Z",
      when: "2026-11-01 1:30 a.m.",
    });
    // A time of day means that time on the wall, in the time zone it's in that day (EST now).
    expect(await remind({ text: "Water the plants", at: "2026-11-01 09:00" })).toMatchObject({
      at: "2026-11-01T14:00:00.000Z",
    });

    await at("2026-11-01T05:29:00Z");
    expect(await reminders()).toEqual([]);
    // In quiet hours, but you asked for this minute.
    await at("2026-11-01T05:30:00Z");
    expect((await rung("Take the bread out"))?.deliveredAt).not.toBeNull();
    expect(await rung("Check the oven")).toBeUndefined();
    await at("2026-11-01T06:30:00Z");
    expect((await rung("Check the oven"))?.deliveredAt).not.toBeNull();
  });

  it("refuses a time that has passed, or one it can't read", async () => {
    h = await createJarvisHarness("2026-10-01T14:00:00Z");
    for (const input of [
      { text: "Call Sam", at: "2026-10-01 09:00" },
      { text: "Call Sam", at: "3pm" },
      { text: "Call Sam", at: "15:00", inMinutes: 5 },
      { text: "‮ ", inMinutes: 5 },
    ]) {
      const res = await h.kernel.execute("reminder.create", input, ownerCaller());
      expect(res).toMatchObject({ status: "error" });
    }
  });
});

describe("a reminder Jarvis set after reading outside content", () => {
  const fromMail = jarvisCaller("untrusted");

  it("waits for quiet hours to end, while yours rings", async () => {
    h = await createJarvisHarness("2026-10-02T01:00:00Z"); // Thursday 9 p.m.
    expect(await remind({ text: "Pay the invoice", at: "23:00" }, fromMail)).toMatchObject({
      at: "2026-10-02T03:00:00.000Z",
      note: expect.stringContaining("waits"),
    });
    await remind({ text: "Lock the door", at: "23:00" });

    await at("2026-10-02T03:00:00Z"); // 11 p.m.
    expect((await rung("Lock the door"))?.deliveredAt).not.toBeNull();
    const held = await rung("Pay the invoice");
    expect(held).toMatchObject({
      deliveredAt: null,
      deadline: null,
      deferredReason: "quiet_hours",
    });
    expect(held?.body).toContain("after reading an email");

    await at("2026-10-02T12:00:30Z"); // just after 8 a.m.
    expect((await rung("Pay the invoice"))?.deliveredAt).not.toBeNull();
  });

  it("can't ring past the day's cap", async () => {
    h = await createJarvisHarness("2026-10-01T14:00:00Z");
    for (let n = 1; n <= 8; n++)
      await h.kernel.execute(
        "inbox.notify",
        { title: `Alert ${n}`, urgency: "interrupt", dedupeKey: `alert:${n}` },
        systemCaller(),
      );
    await remind({ text: "Pay the invoice", inMinutes: 60 }, fromMail);
    await remind({ text: "Lock the door", inMinutes: 60 });
    await at("2026-10-01T15:00:00Z");
    expect((await rung("Lock the door"))?.deliveredAt).not.toBeNull();
    expect(await rung("Pay the invoice")).toMatchObject({
      deliveredAt: null,
      deferredReason: "budget_spent",
    });
  });
});
