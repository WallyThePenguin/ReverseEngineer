// Google's part of the sync check (D55, D61): mail and calendars give their own verdicts, a pause
// Google asked for is calm until it won't let up, and each account gets its own line. The rest of
// checkSyncs is in sync-health.test.ts.
import { calendar, googleAccount, googleQuota, mailAccount, notification } from "@hearth/db";
import { integrationCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES, GOOGLE_SERVICE, SCOPES } from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reportHealth } from "./health.ts";
import { checkSyncs, ErrorClock } from "./sync-health.ts";

const alerts = (t: TestKernel) =>
  t.tdb.db.select().from(notification).where(eq(notification.kind, "system.alert"));

describe("checkSyncs, for Google", () => {
  let t: TestKernel;
  beforeEach(async () => {
    t = await createTestKernel(ALL_MODULES);
  });
  afterEach(() => t.destroy());

  it("leaves mail's verdict to mail itself: a pause is calm, an error fails only once mail says so (D55)", async () => {
    const clock = new ErrorClock();
    const now = t.kernel.clock.now();
    await t.tdb.db.insert(mailAccount).values({
      id: "gmail:me@example.com",
      provider: "gmail",
      address: "me@example.com",
      syncedAt: new Date(now.getTime() - 20 * 60_000),
      // A network error 15 minutes ago, then Google asked Hearth to slow down: the error stays on
      // the row while the account waits out the pause.
      lastError: "socket hang up",
      failures: 1,
      failingSince: new Date(now.getTime() - 15 * 60_000),
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

  it("calls a pause Google won't let up on worth a look, then failing after two hours, saying why", async () => {
    const soon = () => new Date(t.kernel.clock.now().getTime() + 60_000);
    const start = t.kernel.clock.now();
    const reason = "Quota exceeded for quota metric 'Queries' (quota limit: 250)";
    await t.tdb.db.insert(googleAccount).values({ email: "me@example.com", refreshToken: "x" });
    await t.tdb.db.insert(mailAccount).values({
      id: "gmail:me@example.com",
      provider: "gmail",
      address: "me@example.com",
      syncedAt: start,
      syncState: "paused",
      pausedUntil: soon(),
    });
    await t.tdb.db
      .insert(googleQuota)
      .values({ account: "me@example.com", service: "gmail", pausedUntil: soon(), reason });
    const check = async () => (await checkSyncs(t.kernel, new ErrorClock()))[0]!;
    expect(await check()).toMatchObject({ status: "ok" });
    expect((await check()).detail).toContain(reason);

    // Each pause runs out and Google asks again: nothing new for 40 minutes.
    t.clock.advance(40 * 60_000);
    await t.tdb.db.update(mailAccount).set({ pausedUntil: soon() });
    expect(await check()).toMatchObject({
      status: "degraded",
      detail: `me@example.com mail: nothing synced for 40 min, as Google keeps asking Nook to slow down (${reason}); trying again at 10:41 a.m.`,
    });

    t.clock.advance(90 * 60_000);
    await t.tdb.db.update(mailAccount).set({ pausedUntil: soon() });
    const failing = await check();
    expect(failing).toMatchObject({ status: "failing" });
    await reportHealth(t.kernel, [failing]);
    expect(await alerts(t)).toMatchObject([{ title: "Google sync is failing" }]);
  });

  it("takes calendars' verdict from their own sync, one line per account (D61)", async () => {
    await t.tdb.db.insert(googleAccount).values({
      email: "me@example.com",
      refreshToken: "x",
      calendarState: "failing",
      calendarError: "Work: Not Found",
      calendarSyncedAt: t.kernel.clock.now(),
    });
    await t.tdb.db.insert(calendar).values({
      id: "work",
      account: "me@example.com",
      googleId: "work@group.calendar.google.com",
      title: "Work",
      lastError: "Not Found",
    });
    expect(await checkSyncs(t.kernel, new ErrorClock())).toEqual([
      {
        component: "sync.google",
        status: "failing",
        detail: "me@example.com calendar: Work: Not Found",
      },
    ]);

    // One blip, then Google asks Hearth to wait: the pause shows, not the blip from before it.
    const until = new Date(t.kernel.clock.now().getTime() + 60_000);
    await t.tdb.db.update(googleAccount).set({ calendarState: "ok", calendarFailures: 1 });
    await t.tdb.db
      .insert(googleQuota)
      .values({ account: "me@example.com", service: "calendar", pausedUntil: until });
    const [paused] = await checkSyncs(t.kernel, new ErrorClock());
    expect(paused).toMatchObject({ status: "ok" });
    expect(paused?.detail).toMatch(/me@example.com calendar: Google asked Nook to slow down/);
  });
});

describe("a calendar Google says isn't there, from sync to alert", () => {
  const ME = "owner@example.com";
  let t: TestKernel;
  let g: FakeGoogle;
  beforeEach(async () => {
    t = await createTestKernel(ALL_MODULES);
    g = new FakeGoogle(ME);
    g.clock = t.clock;
    t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
    const client = g.client(t.tdb.db);
    const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
    await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  });
  afterEach(() => t.destroy());

  it("closes 'Google sync is failing' once the account's others sync, though it's still selected", async () => {
    const sync = () => t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
    const report = async () => reportHealth(t.kernel, await checkSyncs(t.kernel, new ErrorClock()));
    const primary = (selected: boolean) =>
      t.tdb.db.update(calendar).set({ selected }).where(eq(calendar.googleId, ME));
    g.addCalendar({ id: "holidays", summary: "Holidays", accessRole: "owner" });
    await sync();
    g.brokenCalendars.set("holidays", 404);
    // Failing over it, as the owner's account is from before this fix.
    await primary(false);
    await sync();
    await report();
    expect(await alerts(t)).toMatchObject([{ title: "Google sync is failing", state: "unseen" }]);
    await primary(true);
    await sync();
    await report();
    expect(await alerts(t)).toMatchObject([{ title: "Google sync is failing", state: "done" }]);
  });
});
