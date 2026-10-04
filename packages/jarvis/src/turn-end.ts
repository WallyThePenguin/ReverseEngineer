// How a turn ends (D54). A finished turn is recorded with its outcome. A failed one is tried
// again when that's safe and worth it; otherwise it fails for good: the owner reads why in plain
// words, a routine publishes its plain version, set-aside heartbeat items go back on the pile,
// and an alert goes out when Jarvis looks broken rather than unlucky.
import { localDate } from "@hearth/core";
import { conversationLog, event, heartbeatItem, jarvisTurn, schedule } from "@hearth/db";
import {
  appendEvents,
  getSetting,
  type HearthEvent,
  type Kernel,
  newId,
  type ReflexOutcome,
  systemCaller,
  toHearthEvent,
} from "@hearth/kernel";
import type { LogEntry } from "@hearth/modules";
import { and, count, eq, inArray, lt } from "drizzle-orm";
import { BACKOFF_MINUTES, type Failure, failure, friendlyError, PASSING } from "./failures.ts";
import { failureStreak, STREAK_ALERT } from "./health.ts";
import { applyOutcomes } from "./outcomes.ts";
import { writeLog } from "./threads.ts";
import type { TurnLog } from "./turn-log.ts";

type TurnRow = typeof jarvisTurn.$inferSelect;

/** How long a queued turn is still worth running: a chat for an hour, a voice command for two
 * minutes (the owner is waiting with the cursor in place). */
export const TURN_TTL_MS: Readonly<Record<string, number>> = {
  chat: 3600_000,
  voice_command: 120_000,
};
/** A routine with a plain version publishes that rather than wait longer than this for Claude. */
const FALLBACK_WAIT_MS = 30 * 60_000;
/** With no reset time given, a usage limit is checked again after this. */
const LIMIT_WAIT_MS = 15 * 60_000;
/** Failures that need the owner (or a fix), however they started. */
const NEEDS_YOU = new Set(["invalid_request", "auth", "bad_tool"]);

export interface EndEnv {
  kernel: Kernel;
  log: (msg: string, err?: unknown) => void;
  turnLog?: TurnLog;
}

export interface Ending {
  turn: TurnRow;
  conversationId: string | null;
  /** Hearth tools called this attempt. Once one has, the turn is never tried again. */
  calls: { action: string; risk: string; status: string }[];
  /** The model answered; something failing after that isn't worth another try either. */
  answered: boolean;
  durationMs: number;
  firstTokenMs: number | null;
}

/** Writes how an attempt ended: the turn row, the conversation, the routine's schedule. */
export async function recordEnd(
  env: EndEnv,
  e: Ending,
  patch: Partial<TurnRow> & { status: TurnRow["status"] },
  shown: string = patch.status,
): Promise<void> {
  const { kernel } = env;
  const { turn, conversationId } = e;
  const now = kernel.clock.now();
  await kernel.db
    .update(jarvisTurn)
    .set({ ...patch, finishedAt: now })
    .where(eq(jarvisTurn.id, turn.id));
  const scheduleId = turn.context.scheduleId;
  if (typeof scheduleId === "string")
    await kernel.db.update(schedule).set({ lastOutcome: shown }).where(eq(schedule.id, scheduleId));
  env.turnLog?.({
    at: now.toISOString(),
    turnId: turn.id,
    trigger: turn.trigger,
    lane: turn.lane,
    mode: turn.mode,
    status: shown,
    attempt: turn.attempts,
    errorKind: patch.errorKind ?? null,
    durationMs: e.durationMs,
    firstTokenMs: e.firstTokenMs,
    tools: e.calls.length,
  });
  if (!conversationId) return;
  await writeLog(kernel, conversationId, [
    {
      kind: "turn_finished",
      payload: { status: shown, outcome: patch.outcome ?? null },
      turnId: turn.id,
    },
  ]);
  await kernel.db.transaction((tx) =>
    appendEvents(
      tx,
      [
        {
          kind: "jarvis.turn_finished",
          entityId: turn.subjectId ?? conversationId,
          payload: {
            turnId: turn.id,
            trigger: turn.trigger,
            status: shown,
            outcome: patch.outcome ?? null,
            conversationId,
          },
        },
      ],
      { actor: "jarvis", origin: "agent", correlationId: turn.id, at: now },
    ),
  );
}

/** When to try a failed attempt again, or null to give up now. */
export function nextTry(e: Ending, f: Failure, now: Date): Date | null {
  if (!PASSING.has(f.kind) || e.calls.length > 0 || e.answered) return null;
  const tries = Math.max(1, e.turn.attempts);
  if (tries > BACKOFF_MINUTES.length) return null;
  const at =
    f.kind === "rate_limit"
      ? new Date(
          Math.max(
            now.getTime() + 60_000,
            (f.resetsAt?.getTime() ?? now.getTime() + LIMIT_WAIT_MS) + 30_000,
          ),
        )
      : new Date(now.getTime() + BACKOFF_MINUTES[tries - 1]! * 60_000);
  const ttl = TURN_TTL_MS[e.turn.trigger];
  if (ttl !== undefined && at.getTime() > e.turn.queuedAt.getTime() + ttl) return null;
  if (e.turn.fallback?.length && at.getTime() - now.getTime() > FALLBACK_WAIT_MS) return null;
  return at;
}

/** Ends a failed attempt: queued again, or failed (or stopped) for good. */
export async function failTurn(
  env: EndEnv,
  e: Ending,
  f: Failure,
  limitMinutes: number,
): Promise<"retrying" | "failed" | "canceled"> {
  const { kernel } = env;
  const now = kernel.clock.now();
  const { timeZone } = await getSetting(kernel.db, "owner.dayRules");
  const retryAt = nextTry(e, f, now);
  const said = friendlyError(f.kind, { timeZone, now, retryAt, tool: f.tool, limitMinutes });
  if (e.conversationId) {
    const entry: LogEntry =
      f.kind === "canceled"
        ? { kind: "notice", payload: { text: said.text }, turnId: e.turn.id }
        : {
            kind: "error",
            payload: { message: said.text, kind: f.kind, retry: said.retry },
            turnId: e.turn.id,
          };
    await writeLog(kernel, e.conversationId, [entry]).catch((err) =>
      env.log(`couldn't log the error for turn ${e.turn.id}`, err),
    );
  }
  const common = {
    error: f.message.slice(0, 4000),
    errorKind: f.kind,
    toolsUsed: [...new Set(e.calls.map((c) => c.action))],
    writes: e.calls.filter((c) => c.status === "ok" && c.risk !== "read").length,
    durationMs: e.durationMs,
    firstTokenMs: e.firstTokenMs,
  };
  if (retryAt) {
    await recordEnd(
      env,
      e,
      { ...common, status: "queued", notBefore: retryAt, startedAt: null },
      "retrying",
    );
    return "retrying";
  }
  const status = f.kind === "canceled" ? "canceled" : "failed";
  await recordEnd(env, e, { ...common, status });
  if (status === "canceled") return status;
  const fellBack = await applyFallback(env, e.turn);
  await releaseHeartbeat(env, e.turn);
  await alertFailure(env, e.turn, f, said.text, fellBack).catch((err) =>
    env.log(`couldn't raise an alert for turn ${e.turn.id}`, err),
  );
  return status;
}

/** Publishes a failed routine's plain version (the brief or journal without Jarvis's touch). */
async function applyFallback(env: EndEnv, turn: TurnRow): Promise<boolean> {
  const outcomes = (turn.fallback ?? []) as ReflexOutcome[];
  if (outcomes.length === 0) return false;
  const { kernel } = env;
  const [row] =
    turn.sourceEventSeq === null
      ? []
      : await kernel.db.select().from(event).where(eq(event.seq, turn.sourceEventSeq));
  const source: HearthEvent = row
    ? toHearthEvent(row)
    : {
        seq: 0,
        id: newId(),
        at: kernel.clock.now(),
        kind: "jarvis.turn_finished",
        entityId: null,
        actor: "system",
        origin: "system",
        payload: {},
        correlationId: turn.id,
        causationId: null,
      };
  const name = typeof turn.context.source === "string" ? turn.context.source : turn.trigger;
  try {
    await applyOutcomes(kernel, revive(outcomes), { event: source, name, mode: turn.mode }, (m) =>
      env.log(m),
    );
    return true;
  } catch (err) {
    env.log(`publishing the plain version of turn ${turn.id} failed`, err);
    return false;
  }
}

/** Dates come back from the turn row as text. */
function revive(outcomes: ReflexOutcome[]): ReflexOutcome[] {
  return outcomes.map((o) => {
    if (o.kind === "tell" && typeof o.notification.deadline === "string")
      return {
        ...o,
        notification: { ...o.notification, deadline: new Date(o.notification.deadline) },
      };
    if (o.kind === "check_later" && typeof o.at === "string") return { ...o, at: new Date(o.at) };
    return o;
  });
}

/** Items a failed heartbeat turn took go back, for the next heartbeat to pick up. */
async function releaseHeartbeat(env: EndEnv, turn: TurnRow): Promise<void> {
  const ids = turn.context.itemIds;
  if (!Array.isArray(ids) || ids.length === 0) return;
  await env.kernel.db
    .update(heartbeatItem)
    .set({ takenAt: null })
    .where(inArray(heartbeatItem.id, ids.map(String)));
}

const ROUTINE_NAMES: Record<string, string> = {
  brief: "your morning brief",
  journal: "the evening journal",
  memory: "the nightly memory update",
  prep: "meeting prep",
  heartbeat: "a heartbeat check",
};

/**
 * Alerts (pushed to the phone) on a routine failing and on anything that needs the owner, and
 * again after several failures in a row. Each is raised once per kind per day within a run of
 * failures, so a new outage after Jarvis recovered is never swallowed by an earlier one.
 */
async function alertFailure(
  env: EndEnv,
  turn: TurnRow,
  f: Failure,
  said: string,
  fellBack: boolean,
): Promise<void> {
  const { kernel } = env;
  const now = kernel.clock.now();
  const { timeZone } = await getSetting(kernel.db, "owner.dayRules");
  const failed = (await failureStreak(kernel.db, now)).filter((r) => r.status === "failed");
  const start = failed.at(-1)?.id ?? turn.id;
  const notify = async (title: string, body: string, dedupeKey: string) => {
    const res = await kernel.execute(
      "inbox.notify",
      { kind: "system.alert", title, body, urgency: "interrupt", dedupeKey },
      systemCaller(),
    );
    if (res.status !== "ok") env.log(`alert "${title}" wasn't raised: ${JSON.stringify(res)}`);
  };
  const routine = turn.trigger === "routine" ? String(turn.context.routine ?? "") : null;
  if (routine !== null || NEEDS_YOU.has(f.kind)) {
    const what = routine ? (ROUTINE_NAMES[routine] ?? `"${routine}"`) : null;
    const title = what
      ? `Jarvis couldn't finish ${what}`
      : f.kind === "auth"
        ? "Jarvis is signed out of Claude"
        : "Jarvis's turns are failing";
    const body = fellBack ? `${said} Hearth published the plain version instead.` : said;
    await notify(title, body, `jarvis_failed:${f.kind}:${localDate(now, timeZone)}:${start}`);
  }
  if (failed.length >= STREAK_ALERT)
    await notify(
      `Jarvis has failed ${failed.length} turns in a row`,
      `The latest: ${said}`,
      `jarvis_streak:${start}`,
    );
}

/** Tells the owner a tool was left out because Claude rejected it: once per tool per restart. */
export async function alertLeftOut(env: EndEnv, tool: string, since: Date): Promise<void> {
  const res = await env.kernel.execute(
    "inbox.notify",
    {
      kind: "system.alert",
      title: "Jarvis is working without one of its tools",
      body: `Claude rejected the definition of ${tool}, so Jarvis left it out and carried on. Hearth needs a fix for it; the tool stays off until Jarvis restarts.`,
      urgency: "interrupt",
      dedupeKey: `jarvis_left_out:${tool}:${since.toISOString()}`,
    },
    systemCaller(),
  );
  if (res.status !== "ok") env.log(`the alert about ${tool} wasn't raised: ${JSON.stringify(res)}`);
}

/**
 * Queued turns past their time-to-live are dropped rather than answered late: a chat after an
 * hour, a voice command after two minutes. The conversation says so, with a Retry.
 */
export async function expireQueued(env: EndEnv): Promise<number> {
  const { kernel } = env;
  const now = kernel.clock.now();
  let n = 0;
  for (const [trigger, ttl] of Object.entries(TURN_TTL_MS)) {
    const stale = await kernel.db
      .update(jarvisTurn)
      .set({ status: "skipped", skipReason: "expired", errorKind: "expired", finishedAt: now })
      .where(
        and(
          eq(jarvisTurn.status, "queued"),
          eq(jarvisTurn.trigger, trigger as TurnRow["trigger"]),
          lt(jarvisTurn.queuedAt, new Date(now.getTime() - ttl)),
        ),
      )
      .returning();
    for (const turn of stale) {
      n++;
      if (!turn.conversationId) continue;
      const message = "Jarvis didn't get to this in time, so it let it go.";
      await writeLog(kernel, turn.conversationId, [
        { kind: "error", payload: { message, kind: "expired", retry: true }, turnId: turn.id },
      ]).catch((err) => env.log(`couldn't log the expiry of turn ${turn.id}`, err));
    }
  }
  return n;
}

/**
 * After a restart, turns left "running" were cut short. One that hadn't used a tool yet is
 * simply run again; the rest fail, with their conversation told why.
 */
export async function recoverInterrupted(env: EndEnv): Promise<number> {
  const { kernel } = env;
  const rows = await kernel.db.select().from(jarvisTurn).where(eq(jarvisTurn.status, "running"));
  for (const turn of rows) {
    const [used] = await kernel.db
      .select({ n: count() })
      .from(conversationLog)
      .where(and(eq(conversationLog.turnId, turn.id), eq(conversationLog.kind, "tool_call")));
    if ((used?.n ?? 0) === 0 && turn.attempts <= BACKOFF_MINUTES.length) {
      await kernel.db
        .update(jarvisTurn)
        .set({ status: "queued", startedAt: null, errorKind: "interrupted" })
        .where(eq(jarvisTurn.id, turn.id));
      if (turn.conversationId)
        await writeLog(kernel, turn.conversationId, [
          {
            kind: "notice",
            payload: { text: "Jarvis restarted, so it's starting this again." },
            turnId: turn.id,
          },
          { kind: "turn_finished", payload: { status: "retrying" }, turnId: turn.id },
        ]);
      continue;
    }
    const end: Ending = {
      turn,
      conversationId: turn.conversationId,
      calls: [],
      answered: false,
      durationMs: 0,
      firstTokenMs: null,
    };
    await failTurn(env, end, failure("interrupted", "Interrupted by a restart"), 0);
  }
  return rows.length;
}
