// Jarvis's health, worked out from how its turns ended rather than from whether its process is
// up (D54): failing after a turn failed for good, degraded while one waits for a retry or a
// rejected tool is left out, and ok again as soon as a turn finishes.
import { formatTime } from "@hearth/core";
import { type DbOrTx, jarvisTurn } from "@hearth/db";
import { getSetting, type Kernel, systemCaller } from "@hearth/kernel";
import { and, count, desc, eq, gt, gte, inArray, ne, or, sql } from "drizzle-orm";
import { type FailureKind, friendlyError } from "./failures.ts";

type TurnRow = typeof jarvisTurn.$inferSelect;

export interface JarvisHealth {
  status: "ok" | "degraded" | "failing";
  detail: string;
}

/** Failures in a row that count as Jarvis being broken, not unlucky. */
export const STREAK_ALERT = 3;

const WEEK_MS = 7 * 24 * 3600_000;

export interface FailureStreak {
  /** The newest of the run, newest first: failed for good, or waiting to be tried again. */
  recent: TurnRow[];
  /** How many turns in the run failed for good, however long it is. */
  failed: number;
  /** The run's first turn that failed for good: what one outage's alerts are keyed by. */
  firstFailedId: string | null;
}

/** When a turn last ended (or was queued), with ids breaking ties: they're time-ordered. */
const ENDED = sql`(coalesce(${jarvisTurn.finishedAt}, ${jarvisTurn.queuedAt}), ${jarvisTurn.id})`;

/** Turns a restart didn't cut short: one it did isn't Jarvis failing. */
const NOT_INTERRUPTED = or(
  sql`${jarvisTurn.errorKind} IS NULL`,
  ne(jarvisTurn.errorKind, "interrupted"),
);

/**
 * The turns since Jarvis last finished one: failed for good, or waiting to be tried again. A
 * restart cutting a turn short isn't Jarvis failing, so it doesn't count, and neither do failures
 * from before turns counted their attempts (migration 0024). The run is bounded by the last
 * finished turn, not by a number of rows, so a long outage keeps one start and one set of alerts.
 */
export async function failureStreak(db: DbOrTx, now: Date): Promise<FailureStreak> {
  const counted = and(gte(jarvisTurn.queuedAt, new Date(now.getTime() - WEEK_MS)), NOT_INTERRUPTED);
  const [done] = await db
    .select({
      at: sql<string>`coalesce(${jarvisTurn.finishedAt}, ${jarvisTurn.queuedAt})::text`,
      id: jarvisTurn.id,
    })
    .from(jarvisTurn)
    .where(and(counted, eq(jarvisTurn.status, "done")))
    .orderBy(desc(ENDED))
    .limit(1);
  const run = and(
    counted,
    inArray(jarvisTurn.status, ["failed", "queued"]),
    gt(jarvisTurn.attempts, 0),
    done ? sql`${ENDED} > (${done.at}::timestamptz, ${done.id}::uuid)` : undefined,
  );
  const recent = await db.select().from(jarvisTurn).where(run).orderBy(desc(ENDED)).limit(25);
  // The first failure and the count, in one go: count(*) over () counts every row matched.
  const [first] = await db
    .select({ id: jarvisTurn.id, failed: sql<number>`count(*) over ()` })
    .from(jarvisTurn)
    .where(and(run, eq(jarvisTurn.status, "failed")))
    .orderBy(ENDED)
    .limit(1);
  return { recent, failed: Number(first?.failed ?? 0), firstFailedId: first?.id ?? null };
}

export async function jarvisHealth(
  db: DbOrTx,
  now: Date,
  leftOut: string[] = [],
): Promise<JarvisHealth> {
  const { timeZone } = await getSetting(db, "owner.dayRules");
  const streak = await failureStreak(db, now);
  const last = streak.recent[0];
  const said = (r: TurnRow, retryAt: Date | null) =>
    friendlyError((r.errorKind ?? "unknown") as FailureKind, { timeZone, now, retryAt }).text;
  if (last?.status === "failed") {
    const { failed } = streak;
    const at = formatTime(last.finishedAt ?? now, timeZone);
    const run = failed > 1 ? ` That's ${failed} in a row.` : "";
    return { status: "failing", detail: `A turn failed at ${at}: ${said(last, null)}${run}` };
  }
  if (last) return { status: "degraded", detail: `Retrying a turn. ${said(last, last.notBefore)}` };
  if (leftOut.length) {
    const tools = leftOut.join(", ");
    return {
      status: "degraded",
      detail: `Working without ${tools}: Claude rejected ${leftOut.length === 1 ? "its definition" : "their definitions"}.`,
    };
  }
  return { status: "ok", detail: "Running" };
}

/** Records Jarvis's health; a change of status is an event, and a failure an alert. */
export async function reportJarvisHealth(kernel: Kernel, leftOut: string[] = []): Promise<void> {
  const h = await jarvisHealth(kernel.db, kernel.clock.now(), leftOut);
  const res = await kernel.execute("system.report", { component: "jarvis", ...h }, systemCaller());
  if (res.status !== "ok")
    throw new Error(`Couldn't report Jarvis's health: ${JSON.stringify(res)}`);
}

export interface TurnStats {
  since: Date;
  /** Turns by how they ended (or that they haven't yet). */
  byStatus: Record<string, number>;
  /** Failed turns out of those that ended done or failed; 0 when none did. */
  failureRate: number;
  lastFailure: {
    at: Date | null;
    trigger: string;
    kind: string | null;
    error: string | null;
  } | null;
}

/**
 * How Jarvis's turns went lately, for `hearth doctor` and anyone else asking. Turns a restart cut
 * short aren't counted, as in deep health's (apps/server/src/deep-health.ts).
 */
export async function turnStats(db: DbOrTx, now: Date, hours = 24): Promise<TurnStats> {
  const since = new Date(now.getTime() - hours * 3600_000);
  const counts = await db
    .select({ status: jarvisTurn.status, n: count() })
    .from(jarvisTurn)
    .where(and(gte(jarvisTurn.queuedAt, since), NOT_INTERRUPTED))
    .groupBy(jarvisTurn.status);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const ended = (byStatus.done ?? 0) + (byStatus.failed ?? 0);
  const [last] = await db
    .select()
    .from(jarvisTurn)
    .where(and(eq(jarvisTurn.status, "failed"), gte(jarvisTurn.queuedAt, since), NOT_INTERRUPTED))
    .orderBy(desc(jarvisTurn.finishedAt))
    .limit(1);
  return {
    since,
    byStatus,
    failureRate: ended ? (byStatus.failed ?? 0) / ended : 0,
    lastFailure: last
      ? { at: last.finishedAt, trigger: last.trigger, kind: last.errorKind, error: last.error }
      : null,
  };
}
