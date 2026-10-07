// Applies what reflexes decide, cheapest first. Only "turn" spends a model turn, and proactive
// turns pass the pause switch and the daily budget first; when they can't run, their fallback
// (if any) runs instead.
import { weakerOrigin } from "@hearth/core";
import { heartbeatItem, jarvisTurn, schedule } from "@hearth/db";
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
import { eq } from "drizzle-orm";
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

async function setLastOutcome(kernel: Kernel, scheduleId: string, outcome: string) {
  await kernel.db.update(schedule).set({ lastOutcome: outcome }).where(eq(schedule.id, scheduleId));
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
        // A routine's firing: the turn reports back how it went (D54), to the schedule the
        // routine names (Run now fires a one-off schedule of its own) or the one that fired.
        const named = o.context?.scheduleId;
        const scheduleId =
          typeof named === "string"
            ? named
            : src.event.kind === "clock.fired" && typeof src.event.payload.scheduleId === "string"
              ? src.event.payload.scheduleId
              : null;
        const base = {
          trigger: o.trigger,
          mode,
          lane: o.lane,
          // No more trusted than what led to it, nor than what it replays (D58).
          origin: o.untrusted
            ? "untrusted"
            : o.origin
              ? weakerOrigin(o.origin, src.event.origin)
              : src.event.origin,
          prompt: o.prompt,
          // When it was asked, so a request isn't answered long after (D54): see TURN_TTL_MS.
          context: {
            ...o.context,
            source: src.name,
            askedAt: src.event.at.toISOString(),
            ...(scheduleId ? { scheduleId } : {}),
          },
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
          if (scheduleId) await setLastOutcome(kernel, scheduleId, `skipped_${gate.reason}`);
          result.skipped.push(`${src.name}: ${gate.reason}`);
          if (o.fallback?.length) {
            // As trusted as the turn would have been: a brief quoting email is written untrusted.
            const as = { ...src, event: { ...src.event, origin: base.origin } };
            const inner = await applyOutcomes(kernel, o.fallback, as, log);
            result.skipped.push(...inner.skipped);
          }
          break;
        }
        const inserted = await kernel.db
          .insert(jarvisTurn)
          .values({
            ...base,
            id: newId(),
            status: "queued",
            notBefore: o.notBefore ?? now,
            // Published if the model never manages it (D54).
            fallback: o.fallback?.length ? o.fallback : null,
          })
          .onConflictDoNothing()
          .returning({ id: jarvisTurn.id });
        result.turnsQueued += inserted.length;
        if (inserted.length && scheduleId) await setLastOutcome(kernel, scheduleId, "queued");
        if (inserted.length === 0 && base.dedupeKey) {
          // Already done (or doing) this one: say so in the activity rather than vanish.
          await kernel.db.insert(jarvisTurn).values({
            ...base,
            id: newId(),
            dedupeKey: null,
            context: { ...base.context, duplicateOf: base.dedupeKey },
            status: "skipped",
            skipReason: "duplicate",
            finishedAt: now,
          });
          if (scheduleId) await setLastOutcome(kernel, scheduleId, "skipped_duplicate");
          result.skipped.push(`${src.name}: duplicate of ${base.dedupeKey}`);
        }
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
            // Told because of outside content (or saying its words): reading it back is too,
            // unless it's only Hearth's own words. A turn's untrusted caller marks it anyway.
            ...((n.outside ?? src.event.origin === "untrusted") ? { outside: true } : {}),
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
        const caller = callerFor(src);
        const res = await kernel.execute(
          o.action,
          o.input,
          o.ask ? { ...caller, askFirst: o.ask } : caller,
        );
        if (res.status !== "ok" && !(o.ask && res.status === "pending_approval"))
          log(`${src.name}: ${o.action} -> ${JSON.stringify(res)}`);
        break;
      }
      case "batch":
        await kernel.db.insert(heartbeatItem).values({
          id: newId(),
          text: o.text,
          aboutId: o.aboutId ?? null,
          sourceEventSeq: src.event.seq,
          // An email's subject set aside for later is still outside content then (D58).
          origin: src.event.origin,
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
