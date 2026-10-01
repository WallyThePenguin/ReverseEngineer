// Applies what reflexes decide, cheapest first. Only "turn" spends a model turn, and proactive
// turns pass the pause switch and the daily budget first; when they can't run, their fallback
// (if any) runs instead.
import { heartbeatItem, jarvisTurn } from "@hearth/db";
import {
  type Caller,
  type HearthEvent,
  jarvisCaller,
  type Kernel,
  newId,
  type ReflexMode,
  type ReflexOutcome,
  systemCaller,
  upsertSchedule,
} from "@hearth/kernel";
import { proactiveGate } from "./budget.ts";

export interface OutcomeSource {
  event: HearthEvent;
  /** The reflex or routine that decided this. */
  name: string;
  mode: ReflexMode;
}

export interface ApplyResult {
  turnsQueued: number;
  skipped: string[];
}

function callerFor(src: OutcomeSource): Caller {
  const extra = { causationId: src.event.id, correlationId: src.event.correlationId ?? newId() };
  return src.mode === "always" ? systemCaller(extra) : jarvisCaller(src.event.origin, extra);
}

export async function applyOutcomes(
  kernel: Kernel,
  outcomes: ReflexOutcome[],
  src: OutcomeSource,
  log: (msg: string) => void = () => {},
): Promise<ApplyResult> {
  const result: ApplyResult = { turnsQueued: 0, skipped: [] };
  const now = kernel.clock.now();
  for (const o of outcomes) {
    switch (o.kind) {
      case "turn": {
        if (src.mode === "always") {
          log(`${src.name}: "always" reflexes can't spend model turns; dropped`);
          break;
        }
        const mode = src.mode === "reactive" ? "reactive" : "proactive";
        const gate =
          mode === "proactive" ? await proactiveGate(kernel.db, now) : ({ open: true } as const);
        const base = {
          trigger: o.trigger,
          mode,
          lane: o.lane,
          origin: src.event.origin,
          prompt: o.prompt,
          context: { ...o.context, source: src.name },
          conversationId: o.conversationId ?? null,
          subjectId: o.subjectId ?? null,
          sourceEventSeq: src.event.seq,
          dedupeKey: o.dedupeKey ?? null,
          queuedAt: now,
        } as const;
        if (!gate.open) {
          await kernel.db
            .insert(jarvisTurn)
            .values({
              ...base,
              id: newId(),
              status: "skipped",
              skipReason: gate.reason,
              finishedAt: now,
            })
            .onConflictDoNothing();
          result.skipped.push(`${src.name}: ${gate.reason}`);
          if (o.fallback?.length) {
            const inner = await applyOutcomes(kernel, o.fallback, src, log);
            result.skipped.push(...inner.skipped);
          }
          break;
        }
        const inserted = await kernel.db
          .insert(jarvisTurn)
          .values({ ...base, id: newId(), status: "queued", notBefore: o.notBefore ?? now })
          .onConflictDoNothing()
          .returning({ id: jarvisTurn.id });
        result.turnsQueued += inserted.length;
        break;
      }
      case "tell": {
        const n = o.notification;
        const res = await kernel.execute(
          "inbox.notify",
          {
            kind: n.kind,
            title: n.title,
            ...(n.body ? { body: n.body } : {}),
            ...(n.entityId ? { entityId: n.entityId } : {}),
            urgency: n.urgency ?? "normal",
            ...(n.deadline ? { deadline: n.deadline.toISOString() } : {}),
            ...(n.dedupeKey ? { dedupeKey: n.dedupeKey } : {}),
          },
          callerFor(src),
        );
        if (res.status !== "ok") log(`${src.name}: tell failed: ${JSON.stringify(res)}`);
        break;
      }
      case "note": {
        const ob = o.observation;
        const res = await kernel.execute(
          "jarvis.observe",
          { kind: ob.kind, text: ob.text, ...(ob.aboutId ? { aboutId: ob.aboutId } : {}) },
          jarvisCaller(src.event.origin, { causationId: src.event.id }),
        );
        if (res.status !== "ok") log(`${src.name}: note failed: ${JSON.stringify(res)}`);
        break;
      }
      case "act": {
        const res = await kernel.execute(o.action, o.input, callerFor(src));
        if (res.status !== "ok") log(`${src.name}: ${o.action} -> ${JSON.stringify(res)}`);
        break;
      }
      case "batch":
        await kernel.db.insert(heartbeatItem).values({
          id: newId(),
          text: o.text,
          aboutId: o.aboutId ?? null,
          sourceEventSeq: src.event.seq,
          createdAt: now,
        });
        break;
      case "check_later":
        await upsertSchedule(
          kernel.db,
          {
            id: `check:${src.name}:${o.key}`,
            kind: "check",
            runAt: o.at,
            payload: { ...o.payload, reflex: src.name },
          },
          now,
        );
        break;
    }
  }
  return result;
}
