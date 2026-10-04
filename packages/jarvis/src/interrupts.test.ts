// Interrupts held for the night go out in the morning, a deadline from outside content can't
// wake you, and two at once can't overspend the day's budget (D54).
import { notification } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller, systemCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
afterEach(() => h.destroy());

const NIGHT = "2026-10-02T03:00:00Z"; // Thursday 11 p.m.
const MORNING = "2026-10-02T12:00:30Z"; // Friday just after 8 a.m., when quiet hours end

async function notify(input: Record<string, unknown>, caller: Caller = systemCaller()) {
  const res = await h.kernel.execute<{ id: string; delivered: boolean }>(
    "inbox.notify",
    { urgency: "interrupt", ...input },
    caller,
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
}
const row = async (id: string) =>
  (await h.tdb.db.select().from(notification).where(eq(notification.id, id)))[0];

describe("an interrupt held for the night", () => {
  it("goes out when quiet hours end, once", async () => {
    h = await createJarvisHarness(NIGHT);
    const { id, delivered } = await notify({ title: "The garage door is open" });
    expect(delivered).toBe(false);
    await h.settle();
    expect(await row(id)).toMatchObject({ deliveredAt: null, deferredReason: "quiet_hours" });

    h.clock.set(MORNING);
    await h.settle();
    const sent = await row(id);
    expect(sent?.deliveredAt).not.toBeNull();
    expect(sent?.deferredReason).toBeNull();
    const out = await h.events("notification.delivered");
    expect(out).toHaveLength(1);
    expect(out[0]?.payload).toMatchObject({ notificationId: id, delivered: true });
    await h.settle();
    expect(await h.events("notification.delivered")).toHaveLength(1);
  });

  it("stays quiet once you've seen it", async () => {
    h = await createJarvisHarness(NIGHT);
    const { id } = await notify({ title: "The garage door is open" });
    await h.kernel.execute("inbox.mark", { ids: [id], state: "seen" }, ownerCaller());
    h.clock.set(MORNING);
    await h.settle();
    expect((await row(id))?.deliveredAt).toBeNull();
    expect(await h.events("notification.delivered")).toHaveLength(0);
  });

  it("can't be sent by Jarvis itself", async () => {
    h = await createJarvisHarness(NIGHT);
    const { id } = await notify({ title: "The garage door is open" });
    const res = await h.kernel.execute("inbox.deliver", { id }, jarvisCaller("owner"));
    expect(res).toMatchObject({ status: "denied" });
  });
});

describe("a deadline", () => {
  it("wakes you only when Jarvis hadn't read outside content", async () => {
    h = await createJarvisHarness(NIGHT);
    const deadline = "2026-10-02T04:00:00.000Z"; // within the hour
    const outside = await notify(
      { title: "Pay this invoice now", deadline },
      jarvisCaller("untrusted"),
    );
    expect(outside.delivered).toBe(false);
    // Still shown with the item.
    expect((await row(outside.id))?.deadline?.toISOString()).toBe(deadline);
    const own = await notify({ title: "Your flight boards", deadline }, jarvisCaller("agent"));
    expect(own.delivered).toBe(true);
  });
});

describe("the day's budget", () => {
  it("isn't overspent by interrupts arriving at once", async () => {
    h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
    for (let i = 0; i < 7; i++) await notify({ title: `Item ${i}` });
    // Connections ready first, so the writes below really overlap rather than queue for one.
    await Promise.all(
      Array.from({ length: 5 }, () => h.kernel.execute("inbox.list", {}, ownerCaller())),
    );
    // The worker and the Jarvis process write at the same moment: one slot is left, for one.
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, i) => notify({ title: `At once ${i}` })),
    );
    expect(all.filter((r) => r.delivered)).toHaveLength(1);
  });
});
