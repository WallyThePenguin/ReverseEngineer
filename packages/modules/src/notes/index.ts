// Notes: markdown with @links. Jarvis answers @mentions in them (chat module) and offers to turn
// unchecked checklist items into tasks.
import { type PrincipalKind, renderMention } from "@hearth/core";
import { entity } from "@hearth/db";
import {
  ActionError,
  createEntity,
  defineAction,
  defineModule,
  type EntityRow,
  stableHash,
  updateEntity,
} from "@hearth/kernel";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { docActions } from "../docs/index.ts";
import { editAsCaller, finish, openDoc, textOf, writeDoc } from "../docs/store.ts";
import { body, describeRow, id, liveEntity, preview, title } from "../shared.ts";
import { itemLink, openUnlinkedItems } from "./checklist.ts";

const CHECKLIST_SETTLE_MS = 10 * 60 * 1000;
/** Callers that must say which revision they read before rewriting a whole note. */
const AGENTS: PrincipalKind[] = ["agent", "mcp_client"];

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
    ...docActions,
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
      handler(i, ctx) {
        // A rewrite from an old read would undo whatever changed since (D59).
        if (i.body !== undefined && i.revision === undefined && AGENTS.includes(ctx.caller.kind))
          throw new ActionError(
            "invalid_input",
            "Pass revision, the note's revision when you read it, so a rewrite can't undo changes you haven't seen. To change part of a note, use doc_edit.",
          );
        return writeDoc(
          ctx,
          i.id,
          { title: i.title, body: i.body },
          { expectedRevision: i.revision, type: "note" },
        );
      },
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
        // Locked, and read from the doc itself: typing synced a moment ago is in it (D59).
        const [note] = await ctx.tx.select().from(entity).where(eq(entity.id, i.id)).for("update");
        if (!note || note.deletedAt || note.type !== "note")
          throw new ActionError("not_found", "No such note");
        const { doc, pending } = await openDoc(ctx, note);
        const items = openUnlinkedItems(textOf(doc)).filter(
          (it) => !i.lines || i.lines.includes(it.line),
        );
        const created: { id: string; title: string; line: number }[] = [];
        for (const item of items) {
          const task = await ctx.call<EntityRow>("task.create", {
            title: item.text.trim().slice(0, 500),
            body: `From ${renderMention({ type: "note", id: note.id, label: note.title })}`,
          });
          created.push({ id: task.id, title: task.title, line: item.line });
        }
        if (!created.length) return { created };
        // Each item's own text becomes its task's link; nothing else in the note is rewritten.
        await editAsCaller(ctx, note.id, doc, (t) => {
          for (const c of created) {
            const edit = itemLink(t.toString(), c.line, { id: c.id, label: c.title });
            if (edit) t.splice(edit.at, edit.length, edit.insert);
          }
        });
        const out = await updateEntity(ctx, note.id, { body: textOf(doc) });
        await finish(ctx, note.id, out.revision, doc, pending + 1);
        return { created: created.map(({ id, title }) => ({ id, title })) };
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
        // An import's pages aren't to-do lists you're writing: one suggestion per page would
        // bury the inbox.
        if (event.actor === "integration:notion") return [];
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
