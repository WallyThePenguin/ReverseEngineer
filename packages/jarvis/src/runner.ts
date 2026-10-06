// Runs queued turns: builds the prompt and tools, runs the brain within its lane's time limit,
// logs everything to the conversation, posts the reply where it was asked, and records how the
// turn ended. A failure is told in plain words and tried again only when that's safe (D54).
import { conversation, jarvisTurn } from "@hearth/db";
import { getSetting, jarvisCaller, type Kernel } from "@hearth/kernel";
import { type LogEntry, recallMemory, renderMemory } from "@hearth/modules";
import { eq } from "drizzle-orm";
import type pg from "pg";
import type { Brain, BrainEvents, BrainRequest } from "./brain.ts";
import { claimNextTurn, type TurnRow } from "./claim.ts";
import { classifyFailure, type Failure, failure } from "./failures.ts";
import { reportJarvisHealth } from "./health.ts";
import { type MemberTurnEnv, runMemberTurn } from "./member-turn.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { keepTaint, readFrom, restoreTaint } from "./taint.ts";
import { ensureConversation, recapConversation, streamer, withRecap, writeLog } from "./threads.ts";
import { buildTools, readRecord, type ToolCallRecord, type TurnState } from "./tools.ts";
import { checkOpen } from "./trust.ts";
import { alertLeftOut } from "./turn-alerts.ts";
import {
  bounded,
  Deadline,
  ENDED,
  keepSession,
  OUT_OF_STEPS,
  replyOf,
  TURN_LIMIT_MS,
  thinkOn,
  untilEnded,
} from "./turn-budget.ts";
import {
  classifyOutcome,
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
import { TurnStops } from "./turn-stops.ts";

export type { TurnRow } from "./claim.ts";

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
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

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
  /** Running turns' Stops, and their tools: Jarvis's own stop ends them too (service.ts). */
  readonly stops = new TurnStops();
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

  /**
   * Claims the next runnable turn: yours, then Slack members' (one at a time), then proactive
   * ones; one at a time per conversation (claim.ts).
   */
  async claimNext(): Promise<TurnRow | null> {
    await expireQueued(this.env).catch((err) => this.log("expiring old turns failed", err));
    return claimNextTurn(this.kernel, this.kernel.clock.now());
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
    return this.stops.cancel(turnId);
  }

  /** Records Jarvis's health from how its turns are going. */
  reportHealth(): Promise<void> {
    return reportJarvisHealth(this.kernel, [...this.leftOut]);
  }

  private limitFor(turn: TurnRow): number {
    if (turn.trigger === "voice_command") return this.limits.voice;
    if (turn.trigger === "slack_member") return this.limits.member;
    return this.limits[turn.lane];
  }

  async run(turn: TurnRow): Promise<void> {
    const started = performance.now();
    const stop = this.stops.start(turn.id);
    const deadline = new Deadline(this.limitFor(turn), this.limits.browser, stop.signal);
    // The owner's press is also on the turn row, in case its signal is missed.
    const asked = () => stopRequested(this.kernel, turn.id);
    const watching = this.stops.watch(stop, asked, this.stopCheckMs);
    const end = newEnding(turn);
    try {
      await this.attempt(end, deadline, started);
    } catch (err) {
      // A turn that used the browser may have had longer than its lane gives.
      const limit = deadline.limitMs;
      // Stop may be on the row before its signal arrives: a turn you stopped isn't queued again.
      const canceled = (stop.signal.aborted && !TurnStops.byJarvis(stop)) || (await asked());
      if (!canceled && TurnStops.byJarvis(stop)) {
        // Cut short by Jarvis's own stop, which isn't a failure: the next start runs it again
        // if it hadn't used a tool, and otherwise says Jarvis restarted (recoverInterrupted).
        this.log(`turn ${turn.id} was cut short: Jarvis is stopping`);
        return;
      }
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
      this.stops.end(turn.id);
      await this.reportHealth().catch((err) => this.log("reporting health failed", err));
    }
  }

  private async attempt(end: Ending, deadline: Deadline, started: number): Promise<void> {
    const { turn } = end;
    // A Slack member's turn runs as them, with only what they may know (D62).
    if (turn.trigger === "slack_member") {
      const think: MemberTurnEnv["think"] = (e, req, ev, afresh) => this.think(e, req, ev, afresh);
      return runMemberTurn({ ...this.env, think }, end, deadline, started);
    }
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
      ...(turn.origin === "untrusted" && turn.trigger === "chat" ? { taintedBy: "heard" } : {}),
    };
    // A conversation that read outside content before starts this turn untrusted (D58).
    const conv = await restoreTaint(this.kernel, cid, state);
    end.readOutside = () => state.origin === "untrusted";
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
    if (record?.fromOutside) readFrom(state, record.source, record.text);
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
      // Untrusted only because of what an earlier turn here read: this one's ask is still yours.
      ...(turn.origin !== "untrusted" && !record?.fromOutside && conv?.taintedAt
        ? { readEarlier: conv.taintSource ?? "outside content" }
        : {}),
    });
    const built = bare
      ? []
      : buildTools(this.kernel, state, (kind, payload) => {
          // Counted as it starts: one still running when the model fails may yet do its thing.
          if (kind === "tool_call") end.started++;
          return log([{ kind, payload, turnId: turn.id }]);
        });
    // Stopped or out of time: nothing more runs. A browser tool gives the turn more time (B1).
    const tools = this.stops.track(bounded(built, deadline, ENDED));
    const stream = streamer(this.pool, cid, turn.id);
    const events: BrainEvents = {
      onText: (d) => stream.push(d),
      onMessage: (text) =>
        void log([{ kind: "assistant_message", payload: { text }, turnId: turn.id }]),
      onExternalContent: (source, text) => readFrom(state, source, text ?? ""),
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
    // Claude lost the session this would resume: what Hearth kept of the conversation, then the ask.
    const afresh = async () =>
      withRecap(turn.prompt, await recapConversation(this.kernel, cid, turn));
    const think = (req: BrainRequest) => this.think(end, req, events, afresh);
    // A kept session holds what was read, so the conversation remembers that first (D58).
    const remember = () => keepTaint(this.kernel, cid, state, conv);
    const keep = (id: string) => remember().then(() => keepSession(this.kernel, cid, id));
    // However it ends, the next turn here knows what this one read.
    const result = await thinkOn(request, think, state.calls, keep).finally(() => {
      stream.end();
      return remember();
    });
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
   * Runs the brain until the turn is stopped or out of time, whether or not the brain notices,
   * and doesn't start it once it is (untilEnded). Before any tool has run, two failures are
   * worked around once each: a tool Claude rejects is left out, and a session Claude lost is
   * replaced by a new one, which starts from `afresh`: the prompt the turn writes from what Hearth
   * kept of the conversation (D54). The turn writes it, not this, because a Slack member's turn
   * must keep their words, earlier ones too, inside asUntrusted there as well (D62).
   */
  private async think(
    end: Ending,
    request: BrainRequest,
    events: BrainEvents,
    afresh: () => Promise<string>,
  ) {
    const { signal } = request;
    let req = withoutTools(request, this.leftOut);
    let leftOut = false;
    let recapped = false;
    for (;;) {
      try {
        return await untilEnded(signal, () => this.brain.run(req, events));
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
          await this.kernel.db
            .update(conversation)
            .set({ agentSessionId: null })
            .where(eq(conversation.entityId, end.conversationId));
          req = { ...req, sessionId: null, prompt: await afresh() };
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
