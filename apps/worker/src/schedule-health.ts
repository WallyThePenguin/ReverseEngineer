// Whether schedules fire on time: routines (the brief, prep), reminders, snooze wake-ups and
// checks. The scheduler looks every 5 seconds, so a schedule more than a few minutes late means
// it's stuck, and one it couldn't fire says why (a cron or time zone that doesn't parse). Either
// way the brief or a reminder won't come, so it's reported failing, which tells you.
import { formatDateTime } from "@hearth/core";
import { schedule } from "@hearth/db";
import { getSetting, type Kernel } from "@hearth/kernel";
import { and, asc, count, eq, isNotNull, like, lte, min } from "drizzle-orm";
import type { HealthReport } from "./health.ts";

/** Later than this is overdue. A sleeping PC's backlog fires within seconds of waking. */
export const OVERDUE_MS = 10 * 60_000;

/**
 * The schedules' report. `upSince` is when this worker started, or the PC last woke: until then
 * is as long ago as OVERDUE_MS, what's late may just be the backlog it's still firing.
 */
export async function checkSchedules(kernel: Kernel, upSince: Date): Promise<HealthReport> {
  const now = kernel.clock.now();
  const { timeZone } = await getSetting(kernel.db, "owner.dayRules");
  const broken = await kernel.db
    .select({ id: schedule.id, outcome: schedule.lastOutcome })
    .from(schedule)
    .where(and(eq(schedule.enabled, true), like(schedule.lastOutcome, "error:%")))
    .orderBy(asc(schedule.id))
    .limit(3);
  if (broken.length) {
    const named = broken
      .map((b) => `${b.id} can't run: ${(b.outcome ?? "").replace(/^error: /, "")}`)
      .join("; ");
    return {
      component: "schedules",
      status: "failing",
      detail: `${named}. Nook tries again every hour.`,
    };
  }
  if (now.getTime() - upSince.getTime() < OVERDUE_MS)
    return { component: "schedules", status: "ok", detail: "Catching up" };
  const [late] = await kernel.db
    .select({ n: count(), oldest: min(schedule.nextRunAt) })
    .from(schedule)
    .where(
      and(
        eq(schedule.enabled, true),
        isNotNull(schedule.nextRunAt),
        lte(schedule.nextRunAt, new Date(now.getTime() - OVERDUE_MS)),
      ),
    );
  if (late?.n && late.oldest) {
    const what = late.n === 1 ? "A schedule is" : `${late.n} schedules are`;
    return {
      component: "schedules",
      status: "failing",
      detail: `${what} overdue, the oldest since ${formatDateTime(late.oldest, timeZone)}. The worker's scheduler may be stuck; hearth restart worker starts it afresh.`,
    };
  }
  return { component: "schedules", status: "ok", detail: "On time" };
}

/**
 * The schedules' report for a worker that checks every `everyMs`: a check far later than it was
 * due means the PC was asleep, and the scheduler gets the same grace to catch up as at a start.
 * On waking the health check's timer and the scheduler's are both overdue, and the check may
 * read before the scheduler has fired the morning's brief.
 */
export function scheduleWatch(kernel: Kernel, everyMs: number) {
  let awakeSince = kernel.clock.now();
  let lastLook: number | null = null;
  return () => {
    const now = kernel.clock.now();
    if (lastLook !== null && now.getTime() - lastLook > 3 * everyMs) awakeSince = now;
    lastLook = now.getTime();
    return checkSchedules(kernel, awakeSince);
  };
}
