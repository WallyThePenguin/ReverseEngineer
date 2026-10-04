// Notion import (M7): a Notion export ("Markdown & CSV" zip) becomes notes, subpages under their
// pages, databases as tables with their rows under them, and links between pages as @mentions.
// The import is written by `integration:notion`, so Jarvis reads it as outside content: a team's
// pages are other people's words.
import { entity } from "@hearth/db";
import {
  ActionError,
  createEntity,
  defineAction,
  defineModule,
  syncMentions,
  trashEntity,
} from "@hearth/kernel";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { type ImportFile, MAX_PAGES, planImport } from "./parse.ts";

export type { ImportFile } from "./parse.ts";
export { ExportError, readExport } from "./zip.ts";

/** Uploads waiting for notion.import, by id (the server's import route puts them here). */
export const UPLOADS_SERVICE = "uploads";
export type Uploads = Map<string, ImportFile[]>;

export const notionModule = defineModule({
  name: "notion",
  description: "Notion import: a Notion export becomes notes.",
  entityTypes: [],
  events: [],
  kernelEvents: ["entity.created"],
  knowledge: {},
  actions: [
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
  reflexes: [],
  noReflexesBecause: "An import happens once, when you upload; nothing in it should wake Jarvis.",
});
