// One scheduler for routines, reminders and debounced checks (PLAN.md section 8.4). A firing
// advances next_run_at and appends a clock.fired event in one transaction, so it happens once.
import { isStaleFiring, isValidTimeZone, nextCronRun } from "@hearth/core";
import { type Db, type DbOrTx, schedule, type Tx } from "@hearth/db";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { expireApprovals } from "./approval-life.ts";
import type { Clock } from "./clock.ts";
import { ActionError } from "./errors.ts";
import { appendEvents } from "./events.ts";
import type { Registry } from "./registry.ts";

export type ScheduleRow = typeof schedule.$inferSelect;

export interface ScheduleSpec {
  id: string;
  kind: ScheduleRow["kind"];
  cron?: string | null;
  timeZone?: string;
  runAt?: Date | null;
  payload?: Record<string, unknown>;
  staleAfterSeconds?: number | null;
}

/**
 * Creates or replaces a schedule. A one-shot schedule moves to its new time (that's how checks
 * debounce). A cron schedule keeps its pending firing unless its cron or time zone changed.
 */
export async function upsertSchedule(db: DbOrTx, spec: ScheduleSpec, now: Date): Promise<void> {
  const timeZone = spec.timeZone ?? "America/New_York";
  if (!isValidTimeZone(timeZone))
    throw new ActionError("invalid_input", `"${timeZone}" isn't a time zone Nook knows.`);
  const next = spec.runAt ?? (spec.cron ? nextCronRun(spec.cron, timeZone, now) : null);
  const values = {
    id: spec.id,
    kind: spec.kind,
    cron: spec.cron ?? null,
    timeZone,
    nextRunAt: next,
    payload: spec.payload ?? {},
    staleAfterSeconds: spec.staleAfterSeconds ?? null,
    enabled: true,
  };
  const keepPending = sql`CASE WHEN ${schedule.cron} IS NOT DISTINCT FROM excluded.cron
    AND ${schedule.timeZone} = excluded.time_zone AND ${schedule.nextRunAt} IS NOT NULL
    AND excluded.cron IS NOT NULL THEN ${schedule.nextRunAt} ELSE excluded.next_run_at END`;
  await db
    .insert(schedule)
    .values(values)
    .onConflictDoUpdate({
      target: schedule.id,
      set: {
        kind: values.kind,
        cron: values.cron,
        timeZone,
        payload: values.payload,
        staleAfterSeconds: values.staleAfterSeconds,
        enabled: true,
        nextRunAt: keepPending,
      },
    });
}

export async function cancelSchedule(db: DbOrTx, id: string): Promise<void> {
  await db.update(schedule).set({ nextRunAt: null }).where(eq(schedule.id, id));
}

/** Registers every module routine as "routine:<module>.<name>". */
export async function ensureRoutineSchedules(
  db: Db,
  registry: Registry,
  now: Date,
  timeZone: string,
): Promise<void> {
  for (const [name, routine] of registry.allRoutines()) {
    await upsertSchedule(
      db,
      {
        id: `routine:${name}`,
        kind: "routine",
        cron: routine.cron,
        timeZone,
        payload: { routine: name },
        staleAfterSeconds: routine.staleAfterSeconds,
      },
      now,
    );
  }
}

/** A schedule that couldn't fire is tried again this much later, not on every tick. */
export const SCHEDULE_RETRY_MS = 60 * 60_000;

/** Advances one due schedule and appends its clock.fired event. Throws if it can't. */
async function fire(tx: Tx, row: ScheduleRow, now: Date): Promise<"fired" | "stale"> {
  const scheduledFor = row.nextRunAt!;
  const stale = isStaleFiring(scheduledFor, now, row.staleAfterSeconds);
  const next = row.cron ? nextCronRun(row.cron, row.timeZone, now) : null;
  await tx
    .update(schedule)
    .set({ nextRunAt: next, lastRunAt: now, lastOutcome: stale ? "skipped_stale" : "fired" })
    .where(eq(schedule.id, row.id));
  if (stale) return "stale";
  await appendEvents(
    tx,
    [
      {
        kind: "clock.fired",
        payload: {
          scheduleId: row.id,
          kind: row.kind,
          scheduledFor: scheduledFor.toISOString(),
          ...row.payload,
        },
      },
    ],
    { actor: "system", origin: "system", at: now },
  );
  return "fired";
}

/**
 * Fires every due schedule. Returns how many fired (stale firings are skipped, not counted).
 * Each row fires in a savepoint: one that can't (a cron or time zone that no longer parses) is
 * marked with why, and tried again in an hour, and the rest still fire. It used to stay first in
 * line and fail every tick, so nothing scheduled ran at all.
 */
export async function runDueSchedules(
  db: Db,
  clock: Clock,
  limit = 50,
  log: (line: string) => void = () => {},
): Promise<number> {
  let fired = 0;
  for (let i = 0; i < limit; i++) {
    const now = clock.now();
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schedule)
        .where(
          and(
            eq(schedule.enabled, true),
            isNotNull(schedule.nextRunAt),
            lte(schedule.nextRunAt, now),
          ),
        )
        .orderBy(asc(schedule.nextRunAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row?.nextRunAt) return "empty" as const;
      try {
        return await tx.transaction((sp) => fire(sp, row, now));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        log(`schedule ${row.id} couldn't fire: ${why}`);
        await tx
          .update(schedule)
          .set({
            nextRunAt: new Date(now.getTime() + SCHEDULE_RETRY_MS),
            lastRunAt: now,
            lastOutcome: `error: ${why}`.slice(0, 500),
          })
          .where(eq(schedule.id, row.id));
        return "error" as const;
      }
    });
    if (done === "empty") break;
    if (done === "fired") fired++;
  }
  return fired;
}

/** Polls for due schedules, and runs out approvals past their time (D58), until stopped. */
export function startScheduler(
  db: Db,
  clock: Clock,
  opts: { intervalMs?: number; log?: (e: unknown) => void } = {},
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueSchedules(db, clock, 50, (line) => opts.log?.(line));
    } catch (err) {
      opts.log?.(err);
    }
    try {
      await expireApprovals(db, clock);
    } catch (err) {
      opts.log?.(err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 5000);
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}
