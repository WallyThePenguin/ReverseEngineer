// Notes: markdown with @links. Jarvis answers @mentions in them (chat module) and offers to turn
// unchecked checklist items into tasks.
import { renderMention } from "@hearth/core";
import { entity } from "@hearth/db";
import {
  createEntity,
  defineAction,
  defineModule,
  type EntityRow,
  requireEntity,
  stableHash,
  updateEntity,
} from "@hearth/kernel";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { body, describeRow, id, liveEntity, preview, title } from "../shared.ts";
import { linkItemToTask, openUnlinkedItems } from "./checklist.ts";

const CHECKLIST_SETTLE_MS = 10 * 60 * 1000;

export const notesModule = defineModule({
  name: "notes",
  description: "Notes in markdown, with @links to anything.",
  entityTypes: ["note"],
  events: [],
  knowledge: {
    async note(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "note");
      if (!row) return null;
      const open = openUnlinkedItems(row.body ?? "").length;
      return describeRow(row, open ? [`${open} unchecked item(s) not yet tasks`] : []);
    },
  },
  actions: [
    defineAction({
      name: "note.create",
      description:
        'Create a note. The body is markdown; @mentions are <m-ref type="..." id="...">Label</m-ref> tags.',
      input: z.object({ title, body: body.optional(), parentId: id.optional() }),
      risk: "internal",
      handler: (i, ctx) =>
        createEntity(ctx, {
          type: "note",
          title: i.title,
          body: i.body ?? "",
          parentId: i.parentId ?? null,
        }),
    }),
    defineAction({
      name: "note.update",
      description:
        "Change a note's title or body. Pass revision to fail safely if it changed since you read it.",
      input: z.object({
        id,
        title: title.optional(),
        body: body.optional(),
        revision: z.number().int().optional(),
      }),
      risk: "internal",
      handler: (i, ctx) =>
        updateEntity(
          ctx,
          i.id,
          { title: i.title, body: i.body },
          { expectedRevision: i.revision, type: "note" },
        ),
    }),
    defineAction({
      name: "note.list",
      description: "List notes, most recently changed first.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
      risk: "read",
      async handler(i, ctx) {
        const rows = await ctx.tx
          .select()
          .from(entity)
          .where(and(eq(entity.type, "note"), isNull(entity.deletedAt)))
          .orderBy(desc(entity.updatedAt))
          .limit(i.limit);
        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          preview: preview(r.body),
          updatedAt: r.updatedAt,
        }));
      },
    }),
    defineAction({
      name: "note.extract_tasks",
      description:
        "Turn a note's unchecked checklist items into tasks. Each line then links to its task. Pass lines to pick specific items.",
      input: z.object({ id, lines: z.array(z.number().int().min(0)).optional() }),
      risk: "internal",
      async handler(i, ctx) {
        const note = await requireEntity(ctx.tx, i.id, "note");
        let text = note.body ?? "";
        const items = openUnlinkedItems(text).filter((it) => !i.lines || i.lines.includes(it.line));
        const created: { id: string; title: string }[] = [];
        for (const item of items) {
          const task = await ctx.call<EntityRow>("task.create", {
            title: item.text.trim().slice(0, 500),
            body: `From ${renderMention({ type: "note", id: note.id, label: note.title })}`,
          });
          text = linkItemToTask(text, item.line, { id: task.id, label: task.title });
          created.push({ id: task.id, title: task.title });
        }
        if (created.length) await updateEntity(ctx, note.id, { body: text });
        return { created };
      },
    }),
  ],
  reflexes: [
    {
      name: "notes.offer_checklist_tasks",
      description:
        "When a note has unchecked checklist items that aren't tasks yet, offer to make them tasks.",
      mode: "proactive",
      on: ["entity.created", "entity.updated"],
      run(event, ctx) {
        if (event.payload.type !== "note") return [];
        const changed = event.payload.changed as string[] | undefined;
        if (event.kind === "entity.updated" && !changed?.includes("body")) return [];
        return [
          {
            kind: "check_later",
            key: event.entityId!,
            at: new Date(ctx.now.getTime() + CHECKLIST_SETTLE_MS),
            payload: { noteId: event.entityId },
          },
        ];
      },
      async onCheck(payload, ctx) {
        const note = await liveEntity(ctx.db, String(payload.noteId), "note");
        if (!note) return [];
        const items = openUnlinkedItems(note.body ?? "");
        if (items.length === 0) return [];
        const list = items.map((it) => `- ${it.text}`).join("\n");
        return [
          {
            kind: "tell",
            notification: {
              kind: "suggestion.checklist_tasks",
              title: `Turn ${items.length} unchecked item${items.length === 1 ? "" : "s"} in "${note.title}" into tasks?`,
              body: list,
              entityId: note.id,
              urgency: "quiet",
              dedupeKey: `checklist:${note.id}:${stableHash(items.map((it) => it.text))}`,
            },
          },
        ];
      },
    },
  ],
});
