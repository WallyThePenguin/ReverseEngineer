import { calendar, googleAccount, mailAccount, notification, slackWorkspace } from "@hearth/db";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportHealth } from "./health.ts";
import { checkSyncs, ErrorClock, judgeSync } from "./sync-health.ts";

const NY = "America/New_York";
const now = new Date("2026-10-01T14:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe("judgeSync", () => {
  it("is ok while every source syncs, and names what isn't", () => {
    expect(
      judgeSync("sync.github", [{ name: "me", error: null, lastGood: ago(1) }], now, NY),
    ).toEqual({ component: "sync.github", status: "ok", detail: "Syncing (me)" });
    expect(
      judgeSync(
        "sync.slack",
        [
          { name: "Acme", error: null, lastGood: ago(1) },
          { name: "Home", error: "ratelimited", since: ago(3) },
        ],
        now,
        NY,
      ),
    ).toEqual({
      component: "sync.slack",
      status: "degraded",
      detail: "Home: the last sync failed: ratelimited",
    });
  });

  it("calls an error failing once it has lasted half an hour, or at once if it needs you", () => {
    const lasting = judgeSync(
      "sync.github",
      [{ name: "me", error: "Bad credentials", since: ago(31) }],
      now,
      NY,
    );
    expect(lasting).toMatchObject({ status: "failing" });
    expect(lasting.detail).toBe("me: failing for 31 min: Bad credentials");
    const revoked = { name: "me@example.com", error: "Connect it again.", failing: true };
    expect(judgeSync("sync.google", [revoked], now, NY)).toMatchObject({
      status: "failing",
      detail: "me@example.com: Connect it again.",
    });
  });

  it("notices a sync that stopped quietly, but not one Google asked to slow down", () => {
    expect(
      judgeSync("sync.slack", [{ name: "Acme", error: null, lastGood: ago(45) }], now, NY),
    ).toMatchObject({ status: "degraded", detail: "Acme: last synced 45 min ago" });
    const paused = {
      name: "me@example.com mail",
      error: null,
      lastGood: null,
      pausedUntil: new Date("2026-10-01T14:03:00Z"),
    };
    expect(judgeSync("sync.google", [paused], now, NY)).toMatchObject({
      status: "ok",
      detail: "me@example.com mail: Google asked Hearth to slow down; resuming at 10:03 a.m.",
    });
  });
});

describe("ErrorClock", () => {
  it("dates a run of errors from its first, and starts again after a success", () => {
    const c = new ErrorClock();
    expect(c.since("x", "boom", ago(10))).toEqual(ago(10));
    expect(c.since("x", "still", ago(5))).toEqual(ago(10));
    expect(c.since("x", null, ago(4))).toBeNull();
    expect(c.since("x", "again", ago(3))).toEqual(ago(3));
  });
});

describe("checkSyncs", () => {
  let t: TestKernel;
  beforeEach(async () => {
    t = await createTestKernel(ALL_MODULES);
  });
  afterEach(() => t.destroy());

  it("reports only what's connected, and tells you when a sync fails for half an hour", async () => {
    const clock = new ErrorClock();
    expect(await checkSyncs(t.kernel, clock)).toEqual([]);

    const at = t.kernel.clock.now();
    await t.tdb.db.insert(slackWorkspace).values({
      teamId: "T1",
      teamName: "Acme",
      url: "https://acme.slack.com",
      userId: "U1",
      token: "sealed",
      syncedAt: at,
      lastError: "invalid_auth",
    });
    await t.tdb.db.insert(googleAccount).values({ email: "me@example.com", refreshToken: "x" });
    await t.tdb.db.insert(mailAccount).values({
      id: "gmail:me@example.com",
      provider: "gmail",
      address: "me@example.com",
      syncedAt: at,
    });
    await t.tdb.db.insert(calendar).values({
      id: "me@example.com",
      account: "me@example.com",
      title: "Me",
      lastSyncedAt: at,
    });
    let reports = await checkSyncs(t.kernel, clock);
    expect(reports.map((r) => [r.component, r.status])).toEqual([
      ["sync.google", "ok"],
      ["sync.slack", "degraded"],
    ]);
    await reportHealth(t.kernel, reports);

    t.clock.advance(31 * 60_000);
    // Mail and calendar kept syncing; Slack kept failing.
    const later = t.kernel.clock.now();
    await t.tdb.db.update(mailAccount).set({ syncedAt: later });
    await t.tdb.db.update(calendar).set({ lastSyncedAt: later });
    reports = await checkSyncs(t.kernel, clock);
    expect(reports.find((r) => r.component === "sync.slack")).toMatchObject({
      status: "failing",
      detail: "Acme: failing for 31 min: invalid_auth",
    });
    await reportHealth(t.kernel, reports);
    const told = await t.tdb.db
      .select()
      .from(notification)
      .where(eq(notification.kind, "system.alert"));
    expect(told).toMatchObject([{ title: "Slack sync is failing", urgency: "interrupt" }]);

    // Disconnected: says so, which closes the failing report.
    await t.tdb.db.delete(slackWorkspace);
    reports = await checkSyncs(t.kernel, clock);
    expect(reports.find((r) => r.component === "sync.slack")).toEqual({
      component: "sync.slack",
      status: "ok",
      detail: "Not connected",
    });
  });
});
