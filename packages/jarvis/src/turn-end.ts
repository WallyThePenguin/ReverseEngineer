// How a turn ends (D54). A finished turn is recorded with its outcome. A failed one is tried
// again when that's safe and worth it; otherwise it fails for good: the owner reads why in plain
// words, a routine publishes its plain version, set-aside heartbeat items go back on the pile,
// and an alert goes out when Jarvis looks broken rather than unlucky.
import { weakerOrigin } from "@hearth/core";
import {
  conversationLog,
  event,
  heartbeatItem,
  jarvisTurn,
  schedule,
  type TurnOutcome,
} from "@hearth/db";
import {
  appendEvents,
  getSetting,
  type HearthEvent,
  type Kernel,
  newId,
  type ReflexOutcome,
  toHearthEvent,
} from "@hearth/kernel";
import type { LogEntry } from "@hearth/modules";
import { and, count, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { BACKOFF_MINUTES, type Failure, failure, friendlyError, PASSING } from "./failures.ts";
import { applyOutcomes } from "./outcomes.ts";
import { writeLog } from "./threads.ts";
import type { ToolCallRecord } from "./tools.ts";
import { alertFailure } from "./turn-alerts.ts";
import type { TurnLog } from "./turn-log.ts";

type TurnRow = typeof jarvisTurn.$inferSelect;

/** How long after it was asked a turn is still worth running: a chat for an hour, a voice
 * command for two minutes (the owner is waiting with the cursor in place). */
export const TURN_TTL_MS: Readonly<Record<string, number>> = {
  chat: 3600_000,
  voice_command: 120_000,
};

/** When the owner asked, which can be well before the turn was queued if Jarvis was down. */
const askedAt = (turn: TurnRow): number =>
  Date.parse(String(turn.context.askedAt ?? "")) || turn.queuedAt.getTime();
const ASKED_AT = sql`coalesce((${jarvisTurn.context}->>'askedAt')::timestamptz, ${jarvisTurn.queuedAt})`;
/** A routine with a plain version publishes that rather than wait longer than this for Claude. */
const FALLBACK_WAIT_MS = 30 * 60_000;
/** With no reset time given, a usage limit is checked again after this. */
const LIMIT_WAIT_MS = 15 * 60_000;

export interface EndEnv {
  kernel: Kernel;
  log: (msg: string, err?: unknown) => void;
  turnLog?: TurnLog;
}

export interface Ending {
  turn: TurnRow;
  conversationId: string | null;
  /** Hearth tools that finished this attempt. */
  calls: { action: string; risk: string; status: string }[];
  /** Hearth tools started this attempt, finished or not. Once one has, the turn is never tried
   * again: one still running when the model failed may yet do its thing. */
  started: number;
  /** The model answered; something failing after that isn't worth another try either. */
  answered: boolean;
  durationMs: number;
  firstTokenMs: number | null;
  /** Whether the attempt has read outside content (an email, a web page) so far, or started
   * from some: its row says so once it ends, for what Today shows of it (D58). */
  readOutside: () => boolean;
}

/** An attempt at a turn, before anything has happened in it. */
export const newEnding = (turn: TurnRow): Ending => ({
  turn,
  conversationId: turn.conversationId,
  calls: [],
  started: 0,
  answered: false,
  durationMs: 0,
  firstTokenMs: null,
  readOutside: () => false,
});

/** Whether the owner pressed Stop on a turn, as its row says (the signal can be missed). */
export async function stopRequested(kernel: Kernel, turnId: string): Promise<boolean> {
  const rows = await kernel.db
    .select({ id: jarvisTurn.id })
    .from(jarvisTurn)
    .where(and(eq(jarvisTurn.id, turnId), isNotNull(jarvisTurn.cancelRequestedAt)))
    .catch(() => []);
  return rows.length > 0;
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
  // Its row keeps the origin it was asked with; that it read outside content on the way goes in
  // its context, once it's over (a retry reads afresh).
  const outside = patch.status !== "queued" && turn.origin !== "untrusted" && e.readOutside();
  await kernel.db
    .update(jarvisTurn)
    .set({
      ...patch,
      finishedAt: now,
      ...(outside ? { context: sql`${jarvisTurn.context} || '{"readOutside":true}'::jsonb` } : {}),
    })
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

/** Whether the attempt used a Hearth tool, or started one that may still be running. */
export const usedTools = (e: Ending): boolean => e.started > 0 || e.calls.length > 0;

/** When to try a failed attempt again, or null to give up now. */
export function nextTry(e: Ending, f: Failure, now: Date): Date | null {
  if (!PASSING.has(f.kind) || usedTools(e) || e.answered) return null;
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
  if (ttl !== undefined && at.getTime() > askedAt(e.turn) + ttl) return null;
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
  // As trusted as the turn was: a brief quoting email is written untrusted (D58).
  const from = { ...source, origin: weakerOrigin(source.origin, turn.origin) };
  try {
    await applyOutcomes(kernel, revive(outcomes), { event: from, name, mode: turn.mode }, (m) =>
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
          lt(ASKED_AT, new Date(now.getTime() - ttl)),
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
 * After a restart, turns left "running" were cut short. One you pressed Stop on stays stopped
 * (Jarvis may have been stuck or down when you did). One that hadn't used a tool yet is simply
 * run again; the rest fail, with their conversation told why.
 */
export async function recoverInterrupted(env: EndEnv): Promise<number> {
  const { kernel } = env;
  const rows = await kernel.db.select().from(jarvisTurn).where(eq(jarvisTurn.status, "running"));
  for (const turn of rows) {
    const end = newEnding(turn);
    if (turn.cancelRequestedAt) {
      await failTurn(env, end, failure("canceled", "Stopped by the owner"), 0);
      continue;
    }
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
    await failTurn(env, end, failure("interrupted", "Interrupted by a restart"), 0);
  }
  return rows.length;
}

/** Tools that tell or note rather than act. */
const QUIET_ACTIONS = new Set(["inbox.notify", "jarvis.observe", "record.read"]);

/** What a turn that finished came to, from the tools it ran. */
export function classifyOutcome(calls: ToolCallRecord[]): TurnOutcome {
  const ok = calls.filter((c) => c.status === "ok");
  if (ok.some((c) => c.risk !== "read" && !QUIET_ACTIONS.has(c.action))) return "act";
  if (calls.some((c) => c.status === "pending_approval")) return "ask";
  if (ok.some((c) => c.action === "inbox.notify")) return "tell";
  if (ok.some((c) => c.action === "jarvis.observe")) return "note";
  return "nothing";
}
