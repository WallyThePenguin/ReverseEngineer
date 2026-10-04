import {
  calendar,
  githubAccount,
  googleAccount,
  mailAccount,
  notification,
  slackWorkspace,
} from "@hearth/db";
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
          { name: "Home", error: "ratelimited", failing: false },
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
      "sync.google",
      [{ name: "Me calendar", error: "Not Found", since: ago(31) }],
      now,
      NY,
    );
    expect(lasting).toMatchObject({ status: "failing" });
    expect(lasting.detail).toBe("Me calendar: failing for 31 min: Not Found");
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

const ACME = {
  teamId: "T1",
  teamName: "Acme",
  url: "https://acme.slack.com",
  userId: "U1",
  token: "sealed",
};
const alerts = (t: TestKernel) =>
  t.tdb.db.select().from(notification).where(eq(notification.kind, "system.alert"));

describe("checkSyncs", () => {
  let t: TestKernel;
  beforeEach(async () => {
    t = await createTestKernel(ALL_MODULES);
  });
  afterEach(() => t.destroy());

  it("reports only what's connected, and tells you once Slack says its sync is failing (D61)", async () => {
    const clock = new ErrorClock();
    expect(await checkSyncs(t.kernel, clock)).toEqual([]);

    const at = t.kernel.clock.now();
    await t.tdb.db.insert(slackWorkspace).values({
      ...ACME,
      syncedAt: at,
      lastError: "fetch failed",
      failures: 1,
      failingSince: at,
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
      googleId: "me@example.com",
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
    // Mail and calendar kept syncing; Slack kept failing with nothing read, so after three rounds
    // and half an hour its own sync called it failing (D61).
    const later = t.kernel.clock.now();
    await t.tdb.db.update(mailAccount).set({ syncedAt: later });
    await t.tdb.db.update(calendar).set({ lastSyncedAt: later });
    await t.tdb.db.update(slackWorkspace).set({ syncState: "failing", failures: 3 });
    reports = await checkSyncs(t.kernel, clock);
    expect(reports.find((r) => r.component === "sync.slack")).toMatchObject({
      status: "failing",
      detail: "Acme: fetch failed",
    });
    await reportHealth(t.kernel, reports);
    expect(await alerts(t)).toMatchObject([
      { title: "Slack sync is failing", urgency: "interrupt" },
    ]);

    // Disconnected: says so, which closes the failing report.
    await t.tdb.db.delete(slackWorkspace);
    reports = await checkSyncs(t.kernel, clock);
    expect(reports.find((r) => r.component === "sync.slack")).toEqual({
      component: "sync.slack",
      status: "ok",
      detail: "Not connected",
    });
  });

  it("leaves Slack's verdict to Slack: an error a round reads past is no alert, however old (D61)", async () => {
    const clock = new ErrorClock();
    const start = t.kernel.clock.now();
    // One channel keeps getting Slack's server errors while the rest read in, so every round
    // progressed and Slack's sync still says ok, though the errors began 40 minutes ago.
    await t.tdb.db.insert(slackWorkspace).values({
      ...ACME,
      syncedAt: start,
      lastError: "#general: http_503",
      failures: 4,
      failingSince: new Date(start.getTime() - 40 * 60_000),
    });
    let reports = await checkSyncs(t.kernel, clock);
    expect(reports).toMatchObject([{ component: "sync.slack", status: "degraded" }]);
    await reportHealth(t.kernel, reports);

    t.clock.advance(31 * 60_000);
    await t.tdb.db.update(slackWorkspace).set({ syncedAt: t.kernel.clock.now(), failures: 11 });
    reports = await checkSyncs(t.kernel, clock);
    expect(reports).toEqual([
      {
        component: "sync.slack",
        status: "degraded",
        detail: "Acme: the last sync failed: #general: http_503",
      },
    ]);
    await reportHealth(t.kernel, reports);
    expect(await alerts(t)).toEqual([]);
  });

  it("calls a GitHub token that stopped working failing at once (D61)", async () => {
    const at = t.kernel.clock.now();
    await t.tdb.db.insert(githubAccount).values({
      login: "me",
      token: "sealed",
      syncedAt: at,
      lastError: "Bad credentials",
      syncState: "revoked",
      failures: 1,
      failingSince: at,
    });
    const reports = await checkSyncs(t.kernel, new ErrorClock());
    expect(reports).toEqual([
      { component: "sync.github", status: "failing", detail: "me: Bad credentials" },
    ]);
    await reportHealth(t.kernel, reports);
    expect(await alerts(t)).toMatchObject([
      { title: "GitHub sync is failing", urgency: "interrupt" },
    ]);
  });

  it("leaves mail's verdict to mail itself: a pause is calm, an error fails only once mail says so (D55)", async () => {
    const clock = new ErrorClock();
    const now = t.kernel.clock.now();
    await t.tdb.db.insert(mailAccount).values({
      id: "gmail:me@example.com",
      provider: "gmail",
      address: "me@example.com",
      syncedAt: new Date(now.getTime() - 50 * 60_000),
      // A network error 40 minutes ago, then Google asked Hearth to slow down: the error stays on
      // the row while the account waits out the pause.
      lastError: "socket hang up",
      failures: 1,
      failingSince: new Date(now.getTime() - 40 * 60_000),
      syncState: "paused",
      pausedUntil: new Date(now.getTime() + 2 * 60_000),
    });
    let [google] = await checkSyncs(t.kernel, clock);
    expect(google).toMatchObject({ component: "sync.google", status: "ok" });
    expect(google?.detail).toMatch(/slow down/);

    // The pause is over and it failed again, but mail hasn't called it failing yet (D55 waits for
    // three in a row): worth a look, not an alert.
    await t.tdb.db
      .update(mailAccount)
      .set({ syncState: "catching_up", pausedUntil: null, failures: 2 });
    [google] = await checkSyncs(t.kernel, clock);
    expect(google).toMatchObject({ status: "degraded" });

    await t.tdb.db.update(mailAccount).set({ syncState: "failing", failures: 3 });
    [google] = await checkSyncs(t.kernel, clock);
    expect(google).toMatchObject({ status: "failing" });
  });
});
