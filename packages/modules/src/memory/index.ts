// Jarvis's memory: notes about you, how you work, your preferences and your projects. "Always"
// notes go into every turn; topic notes come in when their keywords come up. Every change is
// kept as a version you can look at and undo (PLAN.md section 6.2).
import type { PrincipalKind } from "@hearth/core";
import { entity, memoryNote, memoryRevision } from "@hearth/db";
import { ActionError, type DigestItem, defineAction, defineModule } from "@hearth/kernel";
import { and, asc, desc, eq, gte, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { describeRow, id, liveEntity } from "../shared.ts";
import { recallMemory } from "./recall.ts";
import { consolidateRoutine } from "./routine.ts";
import {
  changeNote,
  createNote,
  findByTitle,
  loadNote,
  type MemoryNoteView,
  refuseUntrusted,
  toView,
} from "./store.ts";

const noteTitle = z.string().trim().min(1).max(200);
const noteBody = z.string().max(20_000);
const scope = z.enum(["always", "topic"]);
const keywords = z.array(z.string().trim().min(1).max(60)).max(30);
const reason = z.string().trim().max(500).optional();
/** Only you and Jarvis: memory steers every turn, and outside agents aren't to read or plant it. */
const MEMORY_CALLERS: PrincipalKind[] = ["owner", "agent"];

export const memoryModule = defineModule({
  name: "memory",
  description:
    "What Pip remembers: notes about the owner, how they work, their preferences and projects.",
  entityTypes: ["memory_note"],
  events: [
    {
      kind: "memory.changed",
      description: "A memory note was saved or changed. Payload: title, revision, scope, reason.",
    },
  ],
  kernelEvents: ["entity.created", "entity.updated", "entity.deleted"],
  knowledge: {
    async memory_note(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "memory_note");
      if (!row) return null;
      const [m] = await ctx.db.select().from(memoryNote).where(eq(memoryNote.entityId, entityId));
      const when =
        m?.scope === "always"
          ? "remembered in every turn"
          : `remembered when these come up: ${m?.keywords.join(", ") || "(no keywords yet)"}`;
      return describeRow(row, [when]);
    },
  },
  routines: [consolidateRoutine],
  actions: [
    defineAction({
      name: "memory.list",
      description: "Every memory note: title, when it's used (always, or by keywords), and size.",
      input: z.object({}),
      risk: "read",
      callers: MEMORY_CALLERS,
      async handler(_i, ctx) {
        const rows = await ctx.tx
          .select({ e: entity, m: memoryNote })
          .from(entity)
          .innerJoin(memoryNote, eq(memoryNote.entityId, entity.id))
          .where(and(eq(entity.type, "memory_note"), isNull(entity.deletedAt)))
          .orderBy(asc(memoryNote.scope), asc(entity.title));
        return rows.map((r) => ({
          ...toView(r.e, r.m, 0),
          body: undefined,
          chars: (r.e.body ?? "").length,
        }));
      },
    }),
    defineAction({
      name: "memory.get",
      description: "One memory note in full, with its current version number.",
      input: z.object({ id }),
      risk: "read",
      callers: MEMORY_CALLERS,
      handler: (i, ctx) => loadNote(ctx.tx, i.id),
    }),
    defineAction({
      name: "memory.recall",
      description:
        "Look up what you remember about something: the always-on notes plus any topic notes whose keywords appear in the text.",
      input: z.object({ about: z.string().trim().min(1).max(2000) }),
      risk: "read",
      callers: MEMORY_CALLERS,
      handler: (i, ctx) => recallMemory(ctx.tx, i.about),
    }),
    defineAction({
      name: "memory.remember",
      description:
        'Save something durable about the owner: who they are, how they work, a preference, a project. Notes are found by title; saving to an existing title replaces its text, so read it first and keep what still holds. scope "always" is for short notes every turn needs; "topic" notes come in when one of their keywords comes up. Say why in reason. Not for one-off findings (use jarvis_observe).',
      input: z.object({
        title: noteTitle,
        body: noteBody,
        scope: scope.optional(),
        keywords: keywords.optional(),
        reason,
      }),
      risk: "internal",
      callers: MEMORY_CALLERS,
      summarize: (i) => `Remember "${i.title}"`,
      async handler(i, ctx): Promise<MemoryNoteView> {
        refuseUntrusted(ctx);
        const existing = await findByTitle(ctx.tx, i.title);
        if (existing)
          return changeNote(
            ctx,
            existing,
            { body: i.body, scope: i.scope, keywords: i.keywords },
            i.reason ?? null,
          );
        return createNote(
          ctx,
          { title: i.title, body: i.body, scope: i.scope ?? "topic", keywords: i.keywords ?? [] },
          i.reason ?? null,
        );
      },
    }),
    defineAction({
      name: "memory.update",
      description: "Change a memory note's title, text, scope or keywords.",
      input: z.object({
        id,
        title: noteTitle.optional(),
        body: noteBody.optional(),
        scope: scope.optional(),
        keywords: keywords.optional(),
        reason,
        expectedRevision: z.number().int().min(1).optional(),
      }),
      risk: "internal",
      callers: MEMORY_CALLERS,
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        const { id: noteId, reason: why, expectedRevision, ...patch } = i;
        return changeNote(ctx, noteId, patch, why ?? null, expectedRevision);
      },
    }),
    defineAction({
      name: "memory.history",
      description: "Every version of a memory note, newest first: who changed it, when and why.",
      input: z.object({ id }),
      risk: "read",
      callers: MEMORY_CALLERS,
      handler: (i, ctx) =>
        ctx.tx
          .select()
          .from(memoryRevision)
          .where(eq(memoryRevision.entityId, i.id))
          .orderBy(desc(memoryRevision.revision)),
    }),
    defineAction({
      name: "memory.revert",
      description: "Put a memory note back the way it was at an earlier version.",
      input: z.object({ id, revision: z.number().int().min(1) }),
      risk: "internal",
      callers: MEMORY_CALLERS,
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        const [old] = await ctx.tx
          .select()
          .from(memoryRevision)
          .where(and(eq(memoryRevision.entityId, i.id), eq(memoryRevision.revision, i.revision)));
        if (!old) throw new ActionError("not_found", `No version ${i.revision} of that memory`);
        return changeNote(
          ctx,
          i.id,
          { title: old.title, body: old.body, scope: old.scope, keywords: old.keywords },
          `Back to version ${i.revision}`,
        );
      },
    }),
  ],
  reflexes: [],
  async digest(ctx): Promise<DigestItem[]> {
    // Jarvis's own changes to memory, so you see each one in the brief and can undo it.
    const rows = await ctx.db
      .select()
      .from(memoryRevision)
      .where(and(gte(memoryRevision.at, ctx.since), ne(memoryRevision.changedBy, "owner")))
      .orderBy(asc(memoryRevision.at))
      .limit(20);
    return rows.map((r) => ({
      bucket: "handled" as const,
      text: `Updated memory "${r.title}"${r.reason ? `: ${r.reason}` : ""}`,
      entityId: r.entityId,
    }));
  },
});

export { MEMORY_BUDGET_CHARS, mentions, recallMemory, renderMemory } from "./recall.ts";
