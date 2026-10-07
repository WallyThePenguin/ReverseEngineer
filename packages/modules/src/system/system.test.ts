// system.status: what's set up so far, for the "Set up Hearth" checklist; and system alerts.
import { atLocal, localDate } from "@hearth/core";
import { audit, googleAccount, notification, pushSubscription, session } from "@hearth/db";
import { getSetting, ownerCaller, setSetting, systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, ownerCaller("ui"));
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const setup = async () => (await ok<{ setup: Record<string, boolean> }>("system.status", {})).setup;

describe("system.status setup", () => {
  it("starts with nothing connected", async () => {
    expect(await setup()).toEqual({ google: false, chrome: false, phone: false, desktop: false });
  });

  it("sees Google, Chrome, a phone and the desktop app once they're connected", async () => {
    const db = t.tdb.db;
    await db.insert(googleAccount).values({ email: "me@example.com", refreshToken: "x" });
    await setSetting(db, "browser.pairing", { hash: "h", createdAt: new Date().toISOString() });
    await db
      .insert(pushSubscription)
      .values({ endpoint: "https://push.example/1", p256dh: "k", auth: "a", label: "Phone" });
    await db.insert(session).values({
      tokenHash: "t1",
      principal: "owner",
      kind: "api",
      label: "device:desktop",
      scopes: ["voice.clean"],
    });
    expect(await setup()).toEqual({ google: true, chrome: true, phone: true, desktop: true });
  });

  it("doesn't count a revoked Google account or an unpaired device", async () => {
    const db = t.tdb.db;
    await db
      .insert(googleAccount)
      .values({ email: "me@example.com", refreshToken: "x", status: "revoked" });
    await db.insert(session).values({
      tokenHash: "t2",
      principal: "owner",
      kind: "api",
      label: "device:desktop",
      revokedAt: new Date(),
    });
    // A passkey sign-in isn't a paired device.
    await db.insert(session).values({ tokenHash: "t3", principal: "owner", kind: "browser" });
    const s = await setup();
    expect(s.google).toBe(false);
    expect(s.desktop).toBe(false);
  });
});

// Told from the report itself, so nothing waits on the Jarvis process (which runs reflexes).
describe("system alerts", () => {
  const report = (component: string, status: string, detail = "") =>
    t.kernel.execute("system.report", { component, status, detail }, systemCaller());
  const alerts = () =>
    t.tdb.db.select().from(notification).where(eq(notification.kind, "system.alert"));

  it("tells you once a day when a component starts failing, as an interrupt", async () => {
    await report("sync.slack", "ok");
    await report("sync.slack", "failing", "Acme: invalid_auth");
    await report("sync.slack", "failing", "Acme: invalid_auth");
    // Flapping the same day: still one.
    await report("sync.slack", "ok");
    await report("sync.slack", "failing", "Acme: invalid_auth");
    expect(await alerts()).toMatchObject([
      { title: "Slack sync is failing", body: "Acme: invalid_auth", urgency: "interrupt" },
    ]);
    // 10 a.m. on a weekday: within the day's budget, so it goes out (and to the phone) now.
    expect((await alerts())[0]?.deliveredAt).not.toBeNull();
    t.clock.advance(24 * 3_600_000);
    await report("sync.slack", "ok");
    await report("sync.slack", "failing", "Acme: invalid_auth");
    expect(await alerts()).toHaveLength(2);
  });

  it("closes the alert once the component is ok again, whatever day it began", async () => {
    await report("sync.google", "failing", "owner@example.com mail: failing");
    await report("disk", "failing", "1 GB left");
    await report("backup", "failing", "No backup since Monday");
    const states = async () =>
      Object.fromEntries((await alerts()).map((a) => [a.dedupeKey?.split(":")[1], a.state]));
    // Past midnight, Google syncs again: its alert closes. A disk with a little room isn't ok yet.
    t.clock.advance(20 * 3_600_000);
    await report("sync.google", "ok");
    await report("disk", "degraded", "4 GB left");
    expect(await states()).toEqual({ "sync.google": "done", disk: "unseen", backup: "unseen" });
    await report("disk", "ok");
    expect(await states()).toEqual({ "sync.google": "done", disk: "done", backup: "unseen" });
    expect(await t.events("notification.updated")).toHaveLength(2);
  });

  it("opens the day's alert again when the component fails again after it closed, no second buzz", async () => {
    await report("sync.google", "failing", "owner@example.com mail: fetch failed");
    const [first] = await alerts();
    await t.tdb.db.update(notification).set({ snoozedUntil: new Date(0) });
    await report("sync.google", "ok");
    // That afternoon, Google signs Hearth out: the alert is new again, at the top.
    t.clock.advance(4 * 3_600_000);
    await report("sync.google", "failing", "owner@example.com: invalid_grant");
    expect(await alerts()).toMatchObject([
      {
        state: "unseen",
        body: "owner@example.com: invalid_grant",
        deliveredAt: first!.deliveredAt,
        createdAt: t.clock.now(),
        snoozedUntil: null,
      },
    ]);
    expect(await t.events("notification.updated")).toMatchObject([
      { payload: { state: "done" } },
      { payload: { state: "unseen" } },
    ]);
  });

  it("stays as you left it while the component only wavers between failing and degraded", async () => {
    // Ok this morning; the slowdown began later.
    await report("sync.google", "ok");
    t.clock.advance(60 * 60_000);
    await report("sync.google", "failing", "Gmail keeps asking Hearth to slow down");
    const [n] = await alerts();
    await t.kernel.execute("inbox.mark", { ids: [n!.id], state: "done" }, ownerCaller("ui"));
    // A slowdown of hours: degraded while Gmail lets a little through, failing between.
    for (const s of ["degraded", "failing", "degraded", "failing"]) {
      t.clock.advance(5 * 60_000);
      await report("sync.google", s, "Gmail keeps asking Hearth to slow down");
    }
    expect(await alerts()).toMatchObject([{ state: "done" }]);
    // Once it's ok, failing again is news again.
    await report("sync.google", "ok");
    t.clock.advance(60 * 60_000);
    await report("sync.google", "failing", "owner@example.com: invalid_grant");
    expect(await alerts()).toMatchObject([{ state: "unseen" }]);
  });

  it("sends an alert that opens again if it never went out, held through quiet hours", async () => {
    const { timeZone } = await getSetting(t.tdb.db, "owner.dayRules");
    const day = localDate(t.clock.now(), timeZone);
    const at = (hour: number) => t.clock.set(atLocal(day, hour * 60, timeZone));
    // 1 a.m.: held for the morning. Ok again at 2, failing again at 3: still held, until then.
    at(1);
    await report("sync.google", "failing", "fetch failed");
    expect(await alerts()).toMatchObject([{ deliveredAt: null }]);
    at(2);
    await report("sync.google", "ok");
    at(3);
    await report("sync.google", "failing", "fetch failed");
    expect(await alerts()).toMatchObject([{ state: "unseen", deliveredAt: null }]);
    const [held] = (await t.events("notification.updated")).filter(
      (e) => e.payload.state === "unseen",
    );
    expect(held?.payload.retryAt).toEqual(expect.any(String));
    const deliver = ALL_MODULES.flatMap((m) => m.reflexes).find(
      (r) => r.name === "inbox.deliver_held",
    );
    expect(deliver?.on).toContain("notification.updated");
    expect(await deliver!.run(held!, {} as never)).toMatchObject([{ kind: "check_later" }]);
    // Ok before the morning, failing again that afternoon: it goes out now.
    at(4);
    await report("sync.google", "ok");
    at(14);
    await report("sync.google", "failing", "owner@example.com: invalid_grant");
    expect(await alerts()).toMatchObject([{ state: "unseen", deliveredAt: t.clock.now() }]);
    expect(await t.events("notification.delivered")).toHaveLength(1);
  });

  it("closes the alert that no backup has run once one does", async () => {
    await report("backup", "failing", "No backup since Monday");
    await t.kernel.execute("system.backup_finished", { ok: true }, systemCaller());
    expect(await alerts()).toMatchObject([{ state: "done" }]);
  });

  it("keeps an audit row for a check-in only when its status changed", async () => {
    for (const s of ["ok", "ok", "ok", "degraded", "degraded", "ok"]) await report("disk", s);
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "system.report"));
    expect(rows).toHaveLength(3);
  });

  it("leaves Jarvis's own failures to Jarvis, and says when a backup failed", async () => {
    await report("jarvis", "failing", "4 turns failed");
    expect(await alerts()).toEqual([]);
    await t.kernel.execute(
      "system.backup_finished",
      { ok: false, detail: "restic: repository locked" },
      systemCaller(),
    );
    expect(await alerts()).toMatchObject([
      { title: "Last night's backup failed", body: "restic: repository locked" },
    ]);
  });

  it("names every component the worker reports in words", async () => {
    await report("backup", "ok");
    await report("backup", "failing", "No backup since 2026-09-30 3 a.m. Check the backup task.");
    await report("schedules", "failing", "A schedule is overdue");
    expect((await alerts()).map((a) => a.title).sort()).toEqual([
      "Scheduling is failing",
      "The nightly backup is failing",
    ]);
  });
});
