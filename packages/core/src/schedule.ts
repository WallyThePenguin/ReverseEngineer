// Scheduling rules shared by reminders, routines and watches (PLAN.md section 8.4).
import { CronExpressionParser } from "cron-parser";

/** The next time a 5-field cron expression fires strictly after `after`, in `timeZone`. */
export function nextCronRun(cron: string, timeZone: string, after: Date): Date {
  const expr = CronExpressionParser.parse(cron, { currentDate: after, tz: timeZone });
  return expr.next().toDate();
}

export function isValidCron(cron: string): boolean {
  try {
    CronExpressionParser.parse(cron);
    return cron.trim().split(/\s+/).length === 5;
  } catch {
    return false;
  }
}

/**
 * Macro's rule for missed firings: if the PC was off and a firing is older than its stale
 * window, skip it instead of running it late (a 6 a.m. prep packet at 2 p.m. is noise).
 */
export function isStaleFiring(
  scheduledFor: Date,
  now: Date,
  staleAfterSeconds: number | null,
): boolean {
  if (staleAfterSeconds == null) return false;
  return now.getTime() - scheduledFor.getTime() > staleAfterSeconds * 1000;
}
