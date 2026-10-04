// Runs queued turns: builds the prompt and tools, runs the brain within its lane's time limit,
// logs everything to the conversation, posts the reply where it was asked, and records how the
// turn ended. A failure is told in plain words and tried again only when that's safe (D54).
import { conversation, jarvisTurn, type TurnOutcome } from "@hearth/db";
import { getSetting, jarvisCaller, type Kernel } from "@hearth/kernel";
import { type LogEntry, recallMemory, renderMemory } from "@hearth/modules";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type pg from "pg";
import type { Brain, BrainEvents, BrainRequest, BrainResult } from "./brain.ts";
import { classifyFailure, type Failure, failure } from "./failures.ts";
import { reportJarvisHealth } from "./health.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { ensureConversation, recapConversation, streamer, withRecap, writeLog } from "./threads.ts";
import { buildTools, readRecord, type ToolCallRecord, type TurnState } from "./tools.ts";
import { checkOpen, readOutsideContent } from "./trust.ts";
import { alertLeftOut } from "./turn-alerts.ts";
import {
  bounded,
  Deadline,
  keepSession,
  OUT_OF_STEPS,
  replyOf,
  TURN_LIMIT_MS,
  thinkOn,
} from "./turn-budget.ts";
import {
  type Ending,
  expireQueued,
  failTurn,
  newEnding,
  recordEnd,
  recoverInterrupted,
  stopRequested,
  usedTools,
} from "./turn-end.ts";
import type { TurnLog } from "./turn-log.ts";

export type TurnRow = typeof jarvisTurn.$inferSelect;

export interface RunnerOptions {
  kernel: Kernel;
  brain: Brain;
  pool?: pg.Pool | null;
  log?: (msg: string, err?: unknown) => void;
  /** Overrides for the time limits, mostly for tests. */
  limits?: Partial<typeof TURN_LIMIT_MS>;
  /** One line per attempt, for the turn log (D54). */
  turnLog?: TurnLog;
  /** How often a running turn checks whether the owner pressed Stop, in case the signal was missed. */
  stopCheckMs?: number;
}

const REPLY_IN_THREAD = new Set(["mention", "assignment", "watch", "approval"]);
/** Turns whose answer is pasted where nothing can approve it: they only rewrite text (D42). */
const NO_TOOLS = new Set(["voice_command"]);
const QUIET_ACTIONS = new Set(["inbox.notify", "jarvis.observe", "record.read"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);
/** What a tool says once its turn has been stopped or run out of time. */
const ENDED = "Not run: this turn has been stopped. Don't call any more tools.";

export function classifyOutcome(calls: ToolCallRecord[]): TurnOutcome {
  const ok = calls.filter((c) => c.status === "ok");
  if (ok.some((c) => c.risk !== "read" && !QUIET_ACTIONS.has(c.action))) return "act";
  if (calls.some((c) => c.status === "pending_approval")) return "ask";
  if (ok.some((c) => c.action === "inbox.notify")) return "tell";
  if (ok.some((c) => c.action === "jarvis.observe")) return "note";
  return "nothing";
}

/** A request without the tools Claude rejected, so one bad definition can't stop every turn. */
function withoutTools(req: BrainRequest, leftOut: Set<string>): BrainRequest {
  if (leftOut.size === 0) return req;
  const web = [...leftOut].some((t) => WEB_TOOLS.has(t)) ? { web: false } : {};
  return { ...req, ...web, tools: req.tools.filter((t) => !leftOut.has(t.name)) };
}

export class TurnRunner {
  private readonly kernel: Kernel;
  private readonly brain: Brain;
  private readonly pool: pg.Pool | null;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly limits: typeof TURN_LIMIT_MS;
  private readonly turnLog: TurnLog | undefined;
  private readonly stopCheckMs: number;
  private readonly aborts = new Map<string, AbortController>();
  /** Tools Claude rejected since this process started: left out of every turn until a restart. */
  readonly leftOut = new Set<string>();
  private readonly startedAt = new Date();

  constructor(opts: RunnerOptions) {
    this.kernel = opts.kernel;
    this.brain = opts.brain;
    this.pool = opts.pool ?? null;
    this.log = opts.log ?? ((m, e) => console.error(`[jarvis] ${m}`, e ?? ""));
    this.limits = { ...TURN_LIMIT_MS, ...opts.limits };
    this.turnLog = opts.turnLog;
    this.stopCheckMs = opts.stopCheckMs ?? 2000;
  }

  private get env() {
    return {
      kernel: this.kernel,
      log: this.log,
      ...(this.turnLog ? { turnLog: this.turnLog } : {}),
    };
  }

  /** Claims the next runnable turn: reactive before proactive, one at a time per conversation. */
  async claimNext(): Promise<TurnRow | null> {
    await expireQueued(this.env).catch((err) => this.log("expiring old turns failed", err));
    const now = this.kernel.clock.now();
    return this.kernel.db.transaction(async (tx) => {
      // Claims take turns: otherwise two workers could each see "nothing running" for the same
      // conversation before either commits, and answer it twice at once.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jarvis_claim'))`);
      const [next] = await tx
        .select()
        .from(jarvisTurn)
        .where(
          and(
            eq(jarvisTurn.status, "queued"),
            lte(jarvisTurn.notBefore, now),
            sql`NOT EXISTS (SELECT 1 FROM jarvis_turn r WHERE r.status = 'running'
              AND ((r.conversation_id IS NOT NULL AND r.conversation_id = ${jarvisTurn.conversationId})
                OR (r.subject_id IS NOT NULL AND r.subject_id = ${jarvisTurn.subjectId})))`,
          ),
        )
        .orderBy(desc(sql`${jarvisTurn.mode} = 'reactive'`), asc(jarvisTurn.queuedAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!next) return null;
      const [claimed] = await tx
        .update(jarvisTurn)
        .set({ status: "running", startedAt: now, attempts: sql`${jarvisTurn.attempts} + 1` })
        .where(eq(jarvisTurn.id, next.id))
        .returning();
      return claimed ?? null;
    });
  }

  /** Runs queued turns until none are runnable. Returns how many ran. */
  async drain(): Promise<number> {
    let n = 0;
    for (let turn = await this.claimNext(); turn; turn = await this.claimNext()) {
      await this.run(turn);
      n++;
    }
    return n;
  }

  /** Stops a running turn (the owner pressed Stop). False when it isn't running here. */
  cancel(turnId: string): boolean {
    const a = this.aborts.get(turnId);
    a?.abort();
    return Boolean(a);
  }

  /** Records Jarvis's health from how its turns are going. */
  reportHealth(): Promise<void> {
    return reportJarvisHealth(this.kernel, [...this.leftOut]);
  }

  private limitFor(turn: TurnRow): number {
    return turn.trigger === "voice_command" ? this.limits.voice : this.limits[turn.lane];
  }

  async run(turn: TurnRow): Promise<void> {
    const started = performance.now();
    const stop = new AbortController();
    this.aborts.set(turn.id, stop);
    const deadline = new Deadline(this.limitFor(turn), this.limits.browser, stop.signal);
    const watching = this.watchForStop(turn.id, stop);
    const end = newEnding(turn);
    try {
      await this.attempt(end, deadline, started);
    } catch (err) {
      // A turn that used the browser may have had longer than its lane gives.
      const limit = deadline.limitMs;
      // Stop may be on the row before its signal arrives: a turn you stopped isn't queued again.
      const canceled = stop.signal.aborted || (await stopRequested(this.kernel, turn.id));
      const f: Failure = canceled
        ? failure("canceled", "Stopped by the owner")
        : deadline.signal.aborted
          ? failure("timeout", `Ran past its ${Math.round(limit / 60_000)}-minute limit`)
          : classifyFailure(err);
      this.log(`turn ${turn.id} failed (${f.kind})`, err);
      end.durationMs = Math.round(performance.now() - started);
      await failTurn(this.env, end, f, Math.round(limit / 60_000)).catch((e) =>
        this.log(`recording the failure of turn ${turn.id} failed`, e),
      );
    } finally {
      deadline.clear();
      clearInterval(watching);
      this.aborts.delete(turn.id);
      await this.reportHealth().catch((err) => this.log("reporting health failed", err));
    }
  }

  /** Backs up the Stop signal: the owner's press is also on the turn row. */
  private watchForStop(turnId: string, stop: AbortController): NodeJS.Timeout {
    const timer = setInterval(() => {
      void stopRequested(this.kernel, turnId).then((yes) => {
        if (yes) stop.abort();
      });
    }, this.stopCheckMs);
    timer.unref();
    return timer;
  }

  private async attempt(end: Ending, deadline: Deadline, started: number): Promise<void> {
    const { turn } = end;
    const cid = await ensureConversation(this.kernel, turn);
    end.conversationId = cid;
    await this.kernel.db
      .update(jarvisTurn)
      .set({ conversationId: cid })
      .where(eq(jarvisTurn.id, turn.id));
    const state: TurnState = {
      turnId: turn.id,
      conversationId: cid,
      subjectId: turn.subjectId,
      origin: turn.origin,
      causationId: null,
      calls: end.calls as ToolCallRecord[],
      postedToSubject: false,
      seenUrls: new Set(),
      vouchedHosts: new Set(),
      sites: await getSetting(this.kernel.db, "browser.sites"),
    };
    // Log writes are serialized so the log keeps the order things happened in.
    let chain: Promise<void> = Promise.resolve();
    const log = (entries: LogEntry[]) => {
      chain = chain.then(() => writeLog(this.kernel, cid, entries));
      return chain;
    };
    const opening: LogEntry[] = [
      {
        kind: "turn_started",
        payload: { trigger: turn.trigger, lane: turn.lane, attempt: turn.attempts },
        turnId: turn.id,
      },
    ];
    // A retry already showed what it was asked.
    if (turn.trigger !== "chat" && turn.attempts <= 1) {
      opening.push({
        kind: "user_message",
        payload: { text: turn.prompt, by: "system", trigger: turn.trigger },
        turnId: turn.id,
      });
    }
    await log(opening);

    const now = this.kernel.clock.now();
    const record = turn.subjectId ? await readRecord(this.kernel, turn.subjectId) : null;
    // A turn about something an outside tool wrote starts untrusted.
    if (record?.fromOutside) readOutsideContent(state, record.text);
    const subject = record?.text ?? null;
    // A tool-less turn's answer leaves Hearth unseen, so it gets no memory either.
    const bare = NO_TOOLS.has(turn.trigger);
    const memory = bare
      ? null
      : renderMemory(await recallMemory(this.kernel.db, `${turn.prompt}\n${subject ?? ""}`));
    const system = buildSystemPrompt({
      now,
      rules: await getSetting(this.kernel.db, "owner.dayRules"),
      trigger: turn.trigger,
      origin: state.origin,
      paused: await getSetting(this.kernel.db, "jarvis.paused"),
      subject,
      memory,
    });
    const [conv] = await this.kernel.db
      .select()
      .from(conversation)
      .where(eq(conversation.entityId, cid));
    const built = bare
      ? []
      : buildTools(this.kernel, state, (kind, payload) => {
          // Counted as it starts: one still running when the model fails may yet do its thing.
          if (kind === "tool_call") end.started++;
          return log([{ kind, payload, turnId: turn.id }]);
        });
    // Stopped or out of time: nothing more runs. A browser tool gives the turn more time (B1).
    const tools = bounded(built, deadline, ENDED);
    const stream = streamer(this.pool, cid, turn.id);
    const events: BrainEvents = {
      onText: (d) => stream.push(d),
      onMessage: (text) =>
        void log([{ kind: "assistant_message", payload: { text }, turnId: turn.id }]),
      onExternalContent: (_source, text) => readOutsideContent(state, text ?? ""),
      mayFetch: (url) => {
        const verdict = checkOpen(state, url, state.sites);
        if (verdict.kind === "ok") return null;
        return verdict.kind === "blocked"
          ? verdict.reason
          : `${verdict.reason} A web fetch can't wait for that, so open a link from a page you read, or tell the owner what you need.`;
      },
    };
    const request: BrainRequest = {
      system,
      prompt: turn.prompt,
      lane: turn.lane,
      tools,
      ...(bare ? { web: false } : {}),
      sessionId: conv?.agentSessionId ?? null,
      signal: deadline.signal,
    };
    const think = (req: BrainRequest) => this.think(end, req, events);
    const keep = (sessionId: string) => keepSession(this.kernel, cid, sessionId);
    const result = await thinkOn(request, think, state.calls, keep).finally(() => stream.end());
    end.answered = true;
    end.firstTokenMs = result.firstTokenMs;
    // Out of steps isn't a failure: it stops with what it said and offers to carry on (B1).
    if (result.outOfSteps)
      void log([{ kind: "assistant_message", payload: { text: OUT_OF_STEPS }, turnId: turn.id }]);
    await chain;
    const reply = replyOf(result);
    if (reply && turn.subjectId && REPLY_IN_THREAD.has(turn.trigger) && !state.postedToSubject) {
      const posted = await this.kernel.execute(
        "comment.create",
        { parentId: turn.subjectId, body: reply },
        jarvisCaller(state.origin, {
          turnId: turn.id,
          conversationId: cid,
          correlationId: turn.id,
        }),
      );
      if (posted.status !== "ok") this.log(`could not post reply for turn ${turn.id}`, posted);
    }
    end.durationMs = Math.round(performance.now() - started);
    await recordEnd(this.env, end, {
      status: "done",
      outcome: classifyOutcome(state.calls),
      reply: reply || null,
      error: null,
      errorKind: null,
      toolsUsed: [...new Set(state.calls.map((c) => c.action))],
      writes: state.calls.filter((c) => c.status === "ok" && c.risk !== "read").length,
      firstTokenMs: result.firstTokenMs,
      durationMs: end.durationMs,
    });
  }

  /**
   * Runs the brain until the turn is stopped or out of time, whether or not the brain notices.
   * Before any tool has run, two failures are worked around once each: a tool Claude rejects
   * is left out, and a session Claude lost is replaced by a recap Hearth writes (D54).
   */
  private async think(end: Ending, request: BrainRequest, events: BrainEvents) {
    const { signal } = request;
    const stopped = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    let req = withoutTools(request, this.leftOut);
    let leftOut = false;
    let recapped = false;
    for (;;) {
      try {
        return await Promise.race<BrainResult>([this.brain.run(req, events), stopped]);
      } catch (err) {
        if (signal.aborted || usedTools(end)) throw err;
        const f = classifyFailure(err);
        if (f.kind === "bad_tool" && f.tool && !leftOut) {
          leftOut = true;
          this.leftOut.add(f.tool);
          req = withoutTools(req, this.leftOut);
          this.log(`left out the ${f.tool} tool, which Claude rejected: ${f.message}`);
          await alertLeftOut(this.env, f.tool, this.startedAt).catch((e) =>
            this.log("couldn't raise the tool alert", e),
          );
          continue;
        }
        if (f.kind === "session_gone" && req.sessionId && end.conversationId && !recapped) {
          recapped = true;
          const cid = end.conversationId;
          await this.kernel.db
            .update(conversation)
            .set({ agentSessionId: null })
            .where(eq(conversation.entityId, cid));
          const recap = await recapConversation(this.kernel, cid, end.turn);
          req = { ...req, sessionId: null, prompt: withRecap(end.turn.prompt, recap) };
          this.log(`turn ${end.turn.id}: the agent session was gone, so it starts from a recap`);
          continue;
        }
        throw err;
      }
    }
  }

  /** After a restart, turns left "running" were cut short: see recoverInterrupted. */
  recoverInterrupted(): Promise<number> {
    return recoverInterrupted(this.env);
  }
}
