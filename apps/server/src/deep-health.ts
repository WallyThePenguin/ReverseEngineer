// Deep health (D57): what an update gate, `hearth doctor` or the web app needs to call Hearth
// healthy, in one report. The database, whether its migrations fit this code, which build is
// running, every component's last report (a stale one fails), when the Jarvis process last checked
// in, Jarvis's turns, and the Chrome link.
import {
  type Db,
  jarvisTurn,
  migrationState,
  type SqlRunner,
  schemaMismatch,
  setting,
} from "@hearth/db";
import { getSetting, type Settings } from "@hearth/kernel";
import {
  type BrowserStatus,
  type HealthRecord,
  type HealthStatus,
  type JudgedHealth,
  judgeHealth,
} from "@hearth/modules";
import { and, desc, eq, gt, isNotNull, isNull, like, ne, or, sql } from "drizzle-orm";
import { buildId, type VersionStamp } from "./version.ts";

export interface TurnStats {
  /**
   * Turns that finished in the last 24 hours: done, failed or canceled. Not those a restart cut
   * short: that isn't Jarvis failing (D54), and an update's own restart would fail its gate.
   */
  total: number;
  failed: number;
  last: { status: string; trigger: string; at: string; error: string | null } | null;
  /**
   * Failed turns in the last 48 hours by what started them and how they failed, most first:
   * counts only, never a turn's text, so they can be read off the live Hearth safely. Missing
   * from a report by a Hearth from before it.
   */
  failures48h?: { trigger: string; routine: string | null; errorKind: string | null; n: number }[];
}

export interface DeepHealth {
  /** The worst of everything below. */
  status: HealthStatus;
  /** What isn't ok, one line each. */
  problems: string[];
  /** The build the server started with: its commit, or its build time when there's no commit. */
  build: string | null;
  sha: string | null;
  builtAt: string | null;
  startedAt: string | null;
  now: string;
  db: { ok: boolean; ms: number | null };
  migrations: {
    ok: boolean;
    expected: number;
    applied: number;
    missing: string[];
    unknown: string[];
  } | null;
  components: Record<string, JudgedHealth>;
  /**
   * When the Jarvis process last checked in, and since when it's up. Only a running Jarvis writes
   * it; the jarvis component can also be the worker saying Jarvis hasn't checked in.
   */
  jarvisAlive: Settings["jarvis.alive"];
  jarvisTurns24h: TurnStats | null;
  /** The Chrome extension's link; the server doesn't know the extension's id, only its version. */
  browser: {
    connected: boolean;
    version: string | null;
    since: string | null;
    paired: boolean | null;
    /** Why Hearth last couldn't open Chrome, until it connects. */
    openError: string | null;
  } | null;
}

export interface DeepHealthInput {
  db: Db;
  now: Date;
  version: VersionStamp | null;
  startedAt: Date | null;
  browser: BrowserStatus | null;
}

const RANK: Record<HealthStatus, number> = { ok: 0, degraded: 1, failing: 2 };

const firstLine = (text: string | null) => (text ? text.split("\n")[0]!.slice(0, 200) : null);

/**
 * Why a query failed, in words. Drizzle wraps pg's error ("Failed query: SELECT 1"), and a refused
 * connection is an AggregateError with an empty message but a code (ECONNREFUSED).
 */
export function whyFailed(err: unknown): string {
  const e = ((err as { cause?: unknown })?.cause ?? err) as { message?: string; code?: string };
  return firstLine(e?.message || e?.code || String(err)) ?? String(err);
}

/** SQL text through Drizzle, for helpers written against a pool. */
export const sqlRunner = (db: Db): SqlRunner => ({
  query: async <R>(text: string) => ({ rows: (await db.execute(sql.raw(text))).rows as R[] }),
});

/** Routines Hearth itself runs, as their turns name them (context.routine). */
const BUILT_IN_ROUTINES = [
  "brief",
  "journal",
  "heartbeat",
  "prep",
  "memory",
  "follow_ups",
  "reply_drafts",
] as const;

export async function turnStats(db: Db, now: Date): Promise<TurnStats> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  // A turn that ran again and finished has no errorKind (runner.ts): only the cut-short go.
  const counted = or(isNull(jarvisTurn.errorKind), ne(jarvisTurn.errorKind, "interrupted"));
  const rows = await db
    .select({ status: jarvisTurn.status, n: sql<number>`count(*)::int` })
    .from(jarvisTurn)
    .where(and(isNotNull(jarvisTurn.finishedAt), gt(jarvisTurn.finishedAt, since), counted))
    .groupBy(jarvisTurn.status);
  const count = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const [last] = await db
    .select({
      status: jarvisTurn.status,
      trigger: jarvisTurn.trigger,
      at: jarvisTurn.finishedAt,
      error: jarvisTurn.error,
    })
    .from(jarvisTurn)
    .where(and(isNotNull(jarvisTurn.finishedAt), counted))
    .orderBy(desc(jarvisTurn.finishedAt))
    .limit(1);
  // Hearth's own routines by name; one of yours is just "owner_routine", since its name is yours.
  const named = sql.raw(BUILT_IN_ROUTINES.map((r) => `'${r}'`).join(", "));
  const routine = sql<string | null>`CASE WHEN ${jarvisTurn.context}->>'routine' IN (${named})
    THEN ${jarvisTurn.context}->>'routine'
    WHEN ${jarvisTurn.context}->>'routine' IS NOT NULL THEN 'owner_routine' END`;
  const failures = await db
    .select({
      trigger: jarvisTurn.trigger,
      routine,
      errorKind: jarvisTurn.errorKind,
      n: sql<number>`count(*)::int`,
    })
    .from(jarvisTurn)
    .where(
      and(
        eq(jarvisTurn.status, "failed"),
        isNotNull(jarvisTurn.finishedAt),
        gt(jarvisTurn.finishedAt, new Date(now.getTime() - 48 * 3_600_000)),
        counted,
      ),
    )
    .groupBy(jarvisTurn.trigger, routine, jarvisTurn.errorKind)
    .orderBy(desc(sql`count(*)`), jarvisTurn.trigger, routine, jarvisTurn.errorKind)
    .limit(20);
  return {
    total: count("done") + count("failed") + count("canceled"),
    failed: count("failed"),
    failures48h: failures,
    last: last
      ? {
          status: last.status,
          trigger: last.trigger,
          at: last.at!.toISOString(),
          error: firstLine(last.error),
        }
      : null,
  };
}

export async function deepHealth(input: DeepHealthInput): Promise<DeepHealth> {
  const { db, now, version } = input;
  const base = {
    build: version ? buildId(version) : null,
    sha: version?.sha ?? null,
    builtAt: version?.builtAt ?? null,
    startedAt: input.startedAt?.toISOString() ?? null,
    now: now.toISOString(),
    browser: input.browser
      ? {
          connected: input.browser.connected,
          version: input.browser.version,
          since: input.browser.since,
          paired: input.browser.paired ?? null,
          openError: input.browser.openError ?? null,
        }
      : null,
  };
  const started = performance.now();
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    return {
      ...base,
      status: "failing",
      problems: [`Can't reach the database: ${whyFailed(err)}`],
      db: { ok: false, ms: null },
      migrations: null,
      components: {},
      jarvisAlive: null,
      jarvisTurns24h: null,
    };
  }
  const ms = Math.round(performance.now() - started);

  let status: HealthStatus = "ok";
  const problems: string[] = [];
  const add = (s: HealthStatus, problem: string) => {
    problems.push(problem);
    if (RANK[s] > RANK[status]) status = s;
  };

  const state = await migrationState(sqlRunner(db));
  const mismatch = schemaMismatch(state);
  if (mismatch) add("failing", mismatch);
  if (version && version.migrations.join(",") !== state.expected.join(","))
    add(
      "degraded",
      "The web app was built from other code than the server is running. Run `pnpm build:web`, then `hearth restart server`.",
    );

  const components: Record<string, JudgedHealth> = {};
  const rows = await db.select().from(setting).where(like(setting.key, "health.%"));
  for (const r of rows) {
    const name = r.key.slice("health.".length);
    const judged = judgeHealth(name, r.value as HealthRecord, now);
    components[name] = judged;
    if (judged.status !== "ok") add(judged.status, `${name}: ${judged.detail}`);
  }

  const turns = await turnStats(db, now);
  if (turns.last?.status === "failed")
    add("degraded", `Jarvis's last turn failed (${turns.last.at}).`);

  return {
    ...base,
    status,
    problems,
    db: { ok: true, ms },
    migrations: {
      ok: !mismatch,
      expected: state.expected.length,
      applied: state.applied.length,
      missing: state.missing,
      unknown: state.unknown,
    },
    components,
    jarvisAlive: await getSetting(db, "jarvis.alive"),
    jarvisTurns24h: turns,
  };
}
