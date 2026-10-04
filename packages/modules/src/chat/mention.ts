// Jarvis answering an @mention where it was written. Each mention is answered once, keyed by its
// link's anchor (the tag's own id where it has one, D59). A live doc syncs as you type, so the
// mention reaches Hearth before the request after it does: there Jarvis waits until the note has
// been still for a few seconds, then reads the paragraph again as it is by then.
import {
  asUntrusted,
  JARVIS_ENTITY_ID,
  mentionAnchor,
  mentionContext,
  parseMentions,
} from "@hearth/core";
import { entity, event } from "@hearth/db";
import type { ReadContext, ReflexDef, ReflexOutcome } from "@hearth/kernel";
import { and, eq, gt, isNull } from "drizzle-orm";
import { DOC_TYPES } from "../docs/store.ts";
import { routeLane } from "./log.ts";

/** How long a doc must be still before Jarvis reads the request. */
export const MENTION_SETTLE_MS = 8_000;
/** Typing that never stops still gets its answer this long after the mention. */
export const MENTION_MAX_WAIT_MS = 60_000;

/** jarvis.mentioned's payload. */
interface Mentioned {
  type: string;
  parentId: string | null;
  anchor: string;
  context: string;
  /** Written in a record whose text is outside content (D58). */
  outside?: boolean;
}

/** A mention in a doc, waiting for the note to settle. */
interface Waiting extends Mentioned {
  entityId: string;
  /** The mention's own event came from outside content (D25). */
  untrusted: boolean;
  /** When it was first seen. */
  since: string;
  /**
   * The mention's event: writes after it are read with the request, so their trust counts.
   * Missing on checks queued before it was kept: then every write counts.
   */
  seq?: number;
}

function answer(entityId: string, p: Mentioned, context: string, untrusted = false) {
  const subjectId = p.type === "comment" && p.parentId ? p.parentId : entityId;
  return {
    kind: "turn",
    trigger: "mention",
    lane: routeLane(context),
    subjectId,
    dedupeKey: `mention:${entityId}:${p.anchor}`,
    context: { sourceId: entityId, sourceType: p.type },
    prompt: `You were @mentioned in a ${p.type}. Read the record, then answer or do what was asked:\n\n${untrusted ? asUntrusted(context, p.type) : context}`,
    ...(untrusted ? { untrusted: true } : {}),
  } satisfies ReflexOutcome;
}

const later = (w: Waiting, at: Date): ReflexOutcome => ({
  kind: "check_later",
  key: `${w.entityId}:${w.anchor}`,
  at,
  // Only these fields: the clock adds its own (kind, scheduleId) when it fires.
  payload: {
    type: w.type,
    parentId: w.parentId,
    anchor: w.anchor,
    context: w.context,
    entityId: w.entityId,
    untrusted: w.untrusted,
    since: w.since,
    seq: w.seq,
  },
});

/**
 * Whether anything written to the record after the mention came from outside content (Jarvis
 * working on an email, say): the paragraph read now may hold it, so the answer's turn is
 * untrusted too (D25).
 */
async function writtenFromOutside(db: ReadContext["db"], w: Waiting): Promise<boolean> {
  const [hit] = await db
    .select({ seq: event.seq })
    .from(event)
    .where(
      and(
        eq(event.entityId, w.entityId),
        gt(event.seq, w.seq ?? 0),
        eq(event.kind, "entity.updated"),
        eq(event.origin, "untrusted"),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

export const answerMention: ReflexDef = {
  name: "chat.answer_mention",
  description: "When you @mention Jarvis in a note, task, comment or doc, it answers right there.",
  mode: "reactive",
  on: ["jarvis.mentioned"],
  run(event, ctx) {
    const p = event.payload as unknown as Mentioned;
    const entityId = event.entityId!;
    // Written after reading outside content (or on a device's say-so), or in a record whose text
    // is outside content, so what it asks is outside content too, and the turn starts untrusted
    // (D58).
    const untrusted = event.origin === "untrusted" || p.outside === true;
    if (!DOC_TYPES.has(p.type)) return [answer(entityId, p, p.context, untrusted)];
    const w: Waiting = {
      ...p,
      entityId,
      untrusted,
      since: ctx.now.toISOString(),
      seq: event.seq,
    };
    return [later(w, new Date(ctx.now.getTime() + MENTION_SETTLE_MS))];
  },
  async onCheck(payload, ctx) {
    const w = payload as unknown as Waiting;
    const [row] = await ctx.db
      .select()
      .from(entity)
      .where(and(eq(entity.id, w.entityId), isNull(entity.deletedAt)));
    if (!row) return [];
    const now = ctx.now.getTime();
    const settles = row.updatedAt.getTime() + MENTION_SETTLE_MS;
    // Still being written: look again once it's been still for a while.
    if (settles > now && now - Date.parse(w.since) < MENTION_MAX_WAIT_MS)
      return [later(w, new Date(settles))];
    // The request as it reads now; nothing if the mention was deleted meanwhile.
    const body = row.body ?? "";
    const m = parseMentions(body).find(
      (x) => x.id === JARVIS_ENTITY_ID && mentionAnchor(x) === w.anchor,
    );
    if (!m) return [];
    const untrusted = w.untrusted || (await writtenFromOutside(ctx.db, w));
    return [answer(w.entityId, w, mentionContext(body, m.index), untrusted)];
  },
};
