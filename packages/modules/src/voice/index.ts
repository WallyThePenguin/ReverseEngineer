// Voice, workspace side (PLAN.md section 7.2): the desktop app sends what the speech engine heard
// and where you were typing; Hearth cleans it up with your dictionary, snippets and the app's
// style, keeps it in your dictation history, and learns from the fixes you make there.
import { dictation, dictionaryEntry, entity } from "@hearth/db";
import {
  ActionError,
  createEntity,
  defineAction,
  defineModule,
  getSetting,
  newId,
  setSetting,
  updateEntity,
} from "@hearth/kernel";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { describeRow, id, liveEntity, preview } from "../shared.ts";
import { applyDictionary, learnedSwaps, pickStyle, rulesPass, tidy } from "./clean.ts";
import { POLISH_SERVICE, type Polisher } from "./polish.ts";
import { snippetActions, snippetsOf } from "./snippets.ts";

const words = z.string().trim().min(1).max(200);
const style = z.object({
  name: z.string().trim().min(1).max(60),
  match: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(500),
});

const titleOf = (text: string) => preview(text, 80) || "Dictation";

export const voiceModule = defineModule({
  name: "voice",
  description:
    "Dictation: everything you've said into other apps, cleaned up, plus your dictionary, snippets and per-app styles.",
  entityTypes: ["dictation", "snippet"],
  events: [{ kind: "voice.dictated", description: "You dictated something. Payload: app, chars." }],
  kernelEvents: ["entity.created", "entity.updated", "entity.deleted"],
  knowledge: {
    async dictation(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "dictation");
      if (!row) return null;
      const [d] = await ctx.db.select().from(dictation).where(eq(dictation.entityId, entityId));
      return describeRow(row, d?.app ? [`dictated into ${d.app}`] : []);
    },
    async snippet(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "snippet");
      return row ? describeRow(row, [`said as "${row.title}"`]) : null;
    },
  },
  actions: [
    defineAction({
      name: "voice.clean",
      description:
        "Clean up dictated speech (fillers, false starts, your spellings, snippets, the app's style) and keep it in the dictation history. Used by the desktop app.",
      input: z.object({
        raw: z.string().max(20_000),
        app: z.string().max(200).optional(),
        window: z.string().max(300).optional(),
        durationMs: z.number().int().min(0).max(3_600_000).optional(),
        /** False to clean without keeping it (a preview). */
        save: z.boolean().default(true),
      }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const started = Date.now();
        const dict = await ctx.tx.select().from(dictionaryEntry);
        const snippets = await snippetsOf(ctx.tx);
        const chosen = pickStyle(
          await getSetting(ctx.tx, "voice.styles"),
          i.app ?? null,
          i.window ?? null,
        );
        // Snippets go in after the model, so their text is never reworded.
        const spelled = applyDictionary(tidy(i.raw), dict);
        let polisher: Polisher | null = null;
        try {
          polisher = ctx.service<Polisher | null>(POLISH_SERVICE);
        } catch {}
        const polished =
          spelled && polisher
            ? await polisher.polish(spelled, {
                style: chosen?.instructions ?? null,
                terms: dict.map((d) => d.write),
              })
            : null;
        const text = rulesPass(polished ?? spelled, dict, snippets);
        const cleanupMs = Date.now() - started;
        if (!i.save || !text) return { id: null, text, style: chosen?.name ?? null, cleanupMs };
        const row = await createEntity(ctx, {
          type: "dictation",
          title: titleOf(text),
          body: text,
        });
        await ctx.tx.insert(dictation).values({
          entityId: row.id,
          raw: i.raw,
          app: i.app ?? null,
          windowTitle: i.window ?? null,
          style: chosen?.name ?? null,
          durationMs: i.durationMs ?? null,
          cleanupMs,
          polished: polished !== null,
        });
        ctx.emit({
          kind: "voice.dictated",
          entityId: row.id,
          payload: { app: i.app ?? null, chars: text.length },
        });
        return { id: row.id, text, style: chosen?.name ?? null, cleanupMs };
      },
    }),
    defineAction({
      name: "dictation.list",
      description: "Your dictations, newest first, optionally only those containing some words.",
      input: z.object({
        query: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      risk: "read",
      async handler(i, ctx) {
        const like = i.query ? `%${i.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
        const rows = await ctx.tx
          .select({ e: entity, d: dictation })
          .from(dictation)
          .innerJoin(entity, eq(entity.id, dictation.entityId))
          .where(
            and(
              isNull(entity.deletedAt),
              like ? or(ilike(entity.body, like), ilike(dictation.raw, like)) : undefined,
            ),
          )
          .orderBy(desc(entity.createdAt))
          .limit(i.limit);
        return rows.map(({ e, d }) => ({
          id: e.id,
          text: e.body ?? "",
          raw: d.raw,
          app: d.app,
          // A window's title can come from a web page or an email subject: outside content, so
          // only you see it (D25).
          window: ctx.caller.kind === "owner" ? d.windowTitle : null,
          style: d.style,
          polished: d.polished,
          cleanupMs: d.cleanupMs,
          createdAt: e.createdAt,
        }));
      },
    }),
    defineAction({
      name: "dictation.fix",
      description:
        "Correct a dictation's text. A word swap (like 'Otto pair' to 'OtoPair') is learned into the dictionary.",
      input: z.object({ id, text: z.string().trim().min(1).max(20_000) }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const row = await liveEntity(ctx.tx, i.id, "dictation");
        if (!row) throw new ActionError("not_found", "No such dictation");
        const learned = learnedSwaps(row.body ?? "", i.text);
        for (const l of learned) {
          await ctx.tx
            .insert(dictionaryEntry)
            .values({ id: newId(), heard: l.heard, write: l.write, learned: true })
            .onConflictDoNothing();
        }
        await updateEntity(ctx, i.id, { title: titleOf(i.text), body: i.text });
        return { id: i.id, learned };
      },
    }),
    defineAction({
      name: "dictionary.list",
      description:
        "Your dictionary: words the speech engine mishears and how to write them, and terms to spell your way.",
      input: z.object({}),
      risk: "read",
      handler: (_i, ctx) =>
        ctx.tx.select().from(dictionaryEntry).orderBy(sql`lower(${dictionaryEntry.write})`),
    }),
    defineAction({
      name: "dictionary.add",
      description:
        "Add to the dictionary: what's heard and how to write it, or just a term to spell as written.",
      input: z.object({ heard: words.optional(), write: words }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const [made] = await ctx.tx
          .insert(dictionaryEntry)
          .values({ id: newId(), heard: i.heard ?? null, write: i.write })
          .onConflictDoNothing()
          .returning();
        if (!made) throw new ActionError("conflict", "That's already in the dictionary.");
        return made;
      },
    }),
    defineAction({
      name: "dictionary.remove",
      description: "Take an entry out of the dictionary.",
      input: z.object({ id }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const gone = await ctx.tx
          .delete(dictionaryEntry)
          .where(eq(dictionaryEntry.id, i.id))
          .returning({ id: dictionaryEntry.id });
        if (!gone.length) throw new ActionError("not_found", "No such entry");
        return { id: i.id };
      },
    }),
    defineAction({
      name: "voice.styles",
      description: "How dictation is written in each app.",
      input: z.object({}),
      risk: "read",
      handler: (_i, ctx) => getSetting(ctx.tx, "voice.styles"),
    }),
    defineAction({
      name: "voice.set_styles",
      description: "Replace the per-app dictation styles (the first whose match fits wins).",
      input: z.object({ styles: z.array(style).max(30) }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        await setSetting(ctx.tx, "voice.styles", i.styles);
        return i.styles;
      },
    }),
    ...snippetActions,
  ],
  reflexes: [],
  noReflexesBecause:
    "Dictation is you typing by voice: Jarvis reads it when asked, and has nothing to do each time you dictate.",
});
