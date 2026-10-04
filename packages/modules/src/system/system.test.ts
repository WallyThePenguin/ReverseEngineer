// system.status: what's set up so far, for the "Set up Hearth" checklist; and system alerts.
import { audit, googleAccount, notification, pushSubscription, session } from "@hearth/db";
import { ownerCaller, setSetting, systemCaller } from "@hearth/kernel";
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
});
