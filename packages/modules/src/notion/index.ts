// Notion. Import (M7): a Notion export ("Markdown & CSV" zip) becomes notes, subpages under their
// pages, databases as tables with their rows under them, and links between pages as @mentions.
// Tasks (D68): the tickets assigned to you on one task board are read every few minutes, and what
// changes is an event Jarvis makes your tasks from (connect.ts, sync.ts). Both are written by
// `integration:notion`, so Jarvis reads them as outside content: a team's pages are other
// people's words.
import { entity, notionAccount, notionTask } from "@hearth/db";
import {
  ActionError,
  createEntity,
  type DigestItem,
  defineAction,
  defineModule,
  type ReadContext,
  syncMentions,
  trashEntity,
} from "@hearth/kernel";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { syncFailedReflex } from "../connector-health.ts";
import { describeRow, liveEntity } from "../shared.ts";
import { connectActions } from "./connect.ts";
import { type ImportFile, MAX_PAGES, planImport } from "./parse.ts";
import { notionToTasks } from "./to-tasks.ts";

export { httpNotion, NOTION_SERVICE, type NotionApi } from "./api.ts";
export { FakeNotion } from "./fake.ts";
export type { ImportFile } from "./parse.ts";
export { ExportError, readExport } from "./zip.ts";

const syncFailed = syncFailedReflex("notion", "Notion", async (ctx) => {
  const [a] = await ctx.db.select({ since: notionAccount.failingSince }).from(notionAccount);
  return a?.since;
});

/** Tickets that became yours since the last brief, still open and not in your trash. */
async function digest(ctx: ReadContext & { since: Date }): Promise<DigestItem[]> {
  const rows = await ctx.db
    .select({ id: notionTask.entityId, title: entity.title })
    .from(notionTask)
    .innerJoin(entity, eq(entity.id, notionTask.entityId))
    .where(
      and(
        gte(entity.createdAt, ctx.since),
        eq(notionTask.assigned, true),
        eq(notionTask.done, false),
        isNull(entity.deletedAt),
        // The first read brought these in quietly (D68): not news.
        eq(notionTask.backfill, false),
      ),
    )
    .orderBy(desc(entity.createdAt))
    .limit(6);
  const items: DigestItem[] = rows.slice(0, 5).map((r) => ({
    bucket: "today",
    text: `New on your Notion board: ${r.title}`,
    entityId: r.id,
    outside: true,
  }));
  if (rows.length > 5)
    items.push({ bucket: "today", text: "More Notion tickets are yours.", outside: true });
  return items;
}

const TASK_PAYLOAD =
  'Payload: title, status, dueAt ("2026-10-10" for a day, or an ISO time), dueIsDate, url, database, backfill (the first read of the board), caughtUp (told again because its task never came, or is still open)';

/** Uploads waiting for notion.import, by id (the server's import route puts them here). */
export const UPLOADS_SERVICE = "uploads";
export type Uploads = Map<string, ImportFile[]>;

export const notionModule = defineModule({
  name: "notion",
  description:
    "Notion: an export becomes notes, and the tickets assigned to you on your task board come in for Jarvis to make tasks from.",
  entityTypes: ["notion_task"],
  outsideTypes: ["notion_task"],
  events: [
    {
      kind: "notion.task_assigned",
      description: `A ticket on your Notion board became yours and is open: new, assigned to you, or reopened. ${TASK_PAYLOAD}.`,
    },
    {
      kind: "notion.task_done",
      description: `A ticket of yours on your Notion board is done (its status is in the Complete group). ${TASK_PAYLOAD}.`,
    },
    {
      kind: "notion.task_changed",
      description: `An open ticket of yours on your Notion board has a new title or due date. ${TASK_PAYLOAD}, changed ("title" | "due")[].`,
    },
    {
      kind: "notion.task_unassigned",
      description: `An open ticket of yours on your Notion board isn't yours any more: handed to someone else, or deleted. ${TASK_PAYLOAD}.`,
    },
    {
      kind: "notion.sync_failed",
      description:
        "Notion stopped syncing: its secret stopped working (reconnect), the board can't be read, or it kept failing. Sent once when it starts. Payload: errors, since, reconnect.",
    },
  ],
  kernelEvents: ["entity.created", "entity.updated", "notification.updated"],
  knowledge: {
    async notion_task(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "notion_task");
      if (!row) return null;
      const [t] = await ctx.db.select().from(notionTask).where(eq(notionTask.entityId, entityId));
      const [a] = await ctx.db.select({ board: notionAccount.sourceTitle }).from(notionAccount);
      const extra = t
        ? [
            `Notion ticket${a?.board ? ` on ${a.board}` : ""}`,
            t.status ?? "no status",
            ...(t.dueAt ? [`due ${t.dueAt}`] : []),
            ...(t.assigned ? [] : ["no longer assigned to you"]),
            t.url,
          ]
        : [];
      return describeRow(row, extra);
    },
  },
  actions: [
    ...connectActions,
    defineAction({
      name: "notion.import",
      description: "Import an uploaded Notion export as notes.",
      input: z.object({ upload: z.string().uuid(), name: z.string().trim().max(200).optional() }),
      risk: "internal",
      // Only the import route, for you; never Jarvis.
      callers: ["integration"],
      async handler(i, ctx) {
        const uploads = ctx.service<Uploads>(UPLOADS_SERVICE);
        const files = uploads.get(i.upload);
        uploads.delete(i.upload);
        if (!files) throw new ActionError("not_found", "That upload is gone. Upload it again.");
        let plan: ReturnType<typeof planImport>;
        try {
          plan = planImport(files, () => crypto.randomUUID());
        } catch (err) {
          throw new ActionError("invalid_input", (err as Error).message);
        }
        if (plan.length === 0)
          throw new ActionError(
            "invalid_input",
            "No pages in that zip. Export from Notion as Markdown & CSV.",
          );
        const day = ctx.now.toISOString().slice(0, 10);
        const roots = plan.filter((p) => !p.parentKey);
        const home = await createEntity(ctx, {
          type: "note",
          title: `Imported from Notion${i.name ? `: ${i.name}` : ""} (${day})`.slice(0, 500),
          body: [
            `${plan.length} page${plan.length === 1 ? "" : "s"} from Notion. Images and files stayed in Notion.`,
            "",
            ...roots.map(
              (p) => `- <m-ref type="note" id="${p.id}">${p.title.replace(/[<>]/g, "")}</m-ref>`,
            ),
          ].join("\n"),
        });
        const ids = new Map(plan.map((p) => [p.key, p.id]));
        const made = [];
        for (const p of plan)
          made.push(
            await createEntity(ctx, {
              id: p.id,
              type: "note",
              title: p.title || "Untitled",
              body: p.body,
              parentId: p.parentKey ? (ids.get(p.parentKey) ?? home.id) : home.id,
            }),
          );
        // Links to pages made after the page that names them, now that they all exist.
        for (const row of made) if (row.body?.includes("<m-ref")) await syncMentions(ctx, row);
        await syncMentions(ctx, home);
        return {
          id: home.id,
          pages: plan.filter((p) => !p.database).length,
          databases: plan.filter((p) => p.database).length,
        };
      },
    }),
    defineAction({
      name: "notion.imports",
      description:
        "List your Notion imports, newest first: each one's page, and whether it's in the trash.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      risk: "read",
      callers: ["owner"],
      async handler(i, ctx) {
        return ctx.tx
          .select({
            id: entity.id,
            title: entity.title,
            createdAt: entity.createdAt,
            trashedAt: entity.deletedAt,
          })
          .from(entity)
          .where(
            and(
              eq(entity.type, "note"),
              eq(entity.createdBy, "integration:notion"),
              isNull(entity.parentId),
            ),
          )
          .orderBy(desc(entity.createdAt))
          .limit(i.limit);
      },
    }),
    defineAction({
      name: "notion.undo_import",
      description: "Move a Notion import (its notes) to the trash.",
      input: z.object({ id: z.string().uuid() }),
      risk: "destructive",
      callers: ["owner"],
      async handler(i, ctx) {
        const [home] = await ctx.tx
          .select()
          .from(entity)
          .where(and(eq(entity.id, i.id), eq(entity.createdBy, "integration:notion")));
        if (!home) throw new ActionError("not_found", "That isn't a Notion import.");
        const gone: string[] = [];
        let level = [home.id];
        while (level.length && gone.length < MAX_PAGES + 1) {
          gone.push(...level);
          level = (
            await ctx.tx
              .select({ id: entity.id })
              .from(entity)
              .where(
                and(
                  inArray(entity.parentId, level),
                  eq(entity.createdBy, "integration:notion"),
                  isNull(entity.deletedAt),
                ),
              )
          ).map((r) => r.id);
        }
        for (const id of gone) await trashEntity(ctx, id);
        return { trashed: gone.length };
      },
    }),
  ],
  reflexes: [syncFailed, notionToTasks],
  digest,
});
