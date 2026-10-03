// Runs queued turns: builds the prompt and tools, runs the brain, logs everything to the
// conversation, posts the reply where it was asked, and records an audit row for the turn.
import { conversation, jarvisTurn, type TurnOutcome } from "@hearth/db";
import { appendEvents, getSetting, jarvisCaller, type Kernel } from "@hearth/kernel";
import { type LogEntry, recallMemory, renderMemory } from "@hearth/modules";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type pg from "pg";
import type { Brain } from "./brain.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { ensureConversation, streamer, writeLog } from "./threads.ts";
import { buildTools, readRecord, type ToolCallRecord, type TurnState } from "./tools.ts";
import { checkOpen, readOutsideContent } from "./trust.ts";

export type TurnRow = typeof jarvisTurn.$inferSelect;

export interface RunnerOptions {
  kernel: Kernel;
  brain: Brain;
  pool?: pg.Pool | null;
  log?: (msg: string, err?: unknown) => void;
}

const REPLY_IN_THREAD = new Set(["mention", "assignment", "watch", "approval", "voice_command"]);
const QUIET_ACTIONS = new Set(["inbox.notify", "jarvis.observe", "record.read"]);

export function classifyOutcome(calls: ToolCallRecord[]): TurnOutcome {
  const ok = calls.filter((c) => c.status === "ok");
  if (ok.some((c) => c.risk !== "read" && !QUIET_ACTIONS.has(c.action))) return "act";
  if (calls.some((c) => c.status === "pending_approval")) return "ask";
  if (ok.some((c) => c.action === "inbox.notify")) return "tell";
  if (ok.some((c) => c.action === "jarvis.observe")) return "note";
  return "nothing";
}

export class TurnRunner {
  private readonly kernel: Kernel;
  private readonly brain: Brain;
  private readonly pool: pg.Pool | null;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly aborts = new Map<string, AbortController>();

  constructor(opts: RunnerOptions) {
    this.kernel = opts.kernel;
    this.brain = opts.brain;
    this.pool = opts.pool ?? null;
    this.log = opts.log ?? ((m, e) => console.error(`[jarvis] ${m}`, e ?? ""));
  }

  /** Claims the next runnable turn: reactive before proactive, one at a time per conversation. */
  async claimNext(): Promise<TurnRow | null> {
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
        .set({ status: "running", startedAt: now })
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

  cancel(turnId: string): boolean {
    const a = this.aborts.get(turnId);
    a?.abort();
    return Boolean(a);
  }

  async run(turn: TurnRow): Promise<void> {
    const started = performance.now();
    let conversationId: string | null = turn.conversationId;
    try {
      conversationId = await ensureConversation(this.kernel, turn);
      await this.kernel.db
        .update(jarvisTurn)
        .set({ conversationId })
        .where(eq(jarvisTurn.id, turn.id));
      const state: TurnState = {
        turnId: turn.id,
        conversationId,
        subjectId: turn.subjectId,
        origin: turn.origin,
        causationId: null,
        calls: [],
        postedToSubject: false,
        seenUrls: new Set(),
        vouchedHosts: new Set(),
        sites: await getSetting(this.kernel.db, "browser.sites"),
      };
      const cid = conversationId;
      // Log writes are serialized so the log keeps the order things happened in.
      let chain: Promise<void> = Promise.resolve();
      const log = (entries: LogEntry[]) => {
        chain = chain.then(() => writeLog(this.kernel, cid, entries));
        return chain;
      };
      const opening: LogEntry[] = [
        {
          kind: "turn_started",
          payload: { trigger: turn.trigger, lane: turn.lane },
          turnId: turn.id,
        },
      ];
      if (turn.trigger !== "chat") {
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
      const memory = renderMemory(
        await recallMemory(this.kernel.db, `${turn.prompt}\n${subject ?? ""}`),
      );
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
      const tools = buildTools(this.kernel, state, (kind, payload) =>
        log([{ kind, payload, turnId: turn.id }]),
      );
      const stream = streamer(this.pool, cid, turn.id);
      const abort = new AbortController();
      this.aborts.set(turn.id, abort);
      const result = await this.brain
        .run(
          {
            system,
            prompt: turn.prompt,
            lane: turn.lane,
            tools,
            sessionId: conv?.agentSessionId ?? null,
            signal: abort.signal,
          },
          {
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
          },
        )
        .finally(() => {
          this.aborts.delete(turn.id);
          return stream.end();
        });
      await chain;
      if (result.sessionId) {
        await this.kernel.db
          .update(conversation)
          .set({ agentSessionId: result.sessionId })
          .where(eq(conversation.entityId, cid));
      }
      const reply = result.text.trim();
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
      await this.finish(turn, cid, {
        status: "done",
        outcome: classifyOutcome(state.calls),
        reply: reply || null,
        toolsUsed: [...new Set(state.calls.map((c) => c.action))],
        writes: state.calls.filter((c) => c.status === "ok" && c.risk !== "read").length,
        firstTokenMs: result.firstTokenMs,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`turn ${turn.id} failed`, err);
      if (conversationId) {
        await writeLog(this.kernel, conversationId, [
          { kind: "error", payload: { message }, turnId: turn.id },
        ]).catch(() => {});
      }
      await this.finish(turn, conversationId, {
        status: "failed",
        error: message,
        durationMs: Math.round(performance.now() - started),
      });
    }
  }

  private async finish(
    turn: TurnRow,
    conversationId: string | null,
    patch: Partial<TurnRow>,
  ): Promise<void> {
    const now = this.kernel.clock.now();
    await this.kernel.db
      .update(jarvisTurn)
      .set({ ...patch, finishedAt: now })
      .where(eq(jarvisTurn.id, turn.id));
    if (!conversationId) return;
    await writeLog(this.kernel, conversationId, [
      {
        kind: "turn_finished",
        payload: { status: patch.status, outcome: patch.outcome ?? null },
        turnId: turn.id,
      },
    ]);
    await this.kernel.db.transaction((tx) =>
      appendEvents(
        tx,
        [
          {
            kind: "jarvis.turn_finished",
            entityId: turn.subjectId ?? conversationId,
            payload: {
              turnId: turn.id,
              trigger: turn.trigger,
              status: patch.status,
              outcome: patch.outcome ?? null,
              conversationId,
            },
          },
        ],
        { actor: "jarvis", origin: "agent", correlationId: turn.id, at: now },
      ),
    );
  }

  /** After a restart, turns left "running" were interrupted: mark them failed. */
  async recoverInterrupted(): Promise<number> {
    const rows = await this.kernel.db
      .update(jarvisTurn)
      .set({
        status: "failed",
        error: "Interrupted by a restart",
        finishedAt: this.kernel.clock.now(),
      })
      .where(eq(jarvisTurn.status, "running"))
      .returning({ id: jarvisTurn.id });
    return rows.length;
  }
}
