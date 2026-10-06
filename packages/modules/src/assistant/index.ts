// Jarvis's own records and tools: observations, watches, the brief, the journal, and its
// activity feed.
import {
  addLocalDays,
  asUntrusted,
  atLocal,
  filterSchema,
  formatDateTime,
  localDate,
  matches,
} from "@hearth/core";
import { conversation, entity, jarvisTurn, observation, watch } from "@hearth/db";
import {
  ActionError,
  createEntity,
  createNotification,
  type DigestItem,
  defineAction,
  defineModule,
  getSetting,
  newId,
  updateEntity,
} from "@hearth/kernel";
import { and, desc, eq, gt, gte, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { describeRow, id, liveEntity, writtenOutside } from "../shared.ts";
import { didAction } from "./did.ts";
import { briefRoutine, journalRoutine } from "./routines.ts";
import { turnActions } from "./turns.ts";
import { tomorrowAtAGlance } from "./wrap.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function findByTitle(tx: Parameters<typeof liveEntity>[0], type: string, title: string) {
  const [row] = await tx
    .select()
    .from(entity)
    .where(and(eq(entity.type, type), eq(entity.title, title), isNull(entity.deletedAt)));
  return row;
}

/**
 * The evening journal's time (routines.ts). "Your day" comes no earlier, so a note added to the
 * day's journal at 2 p.m. doesn't send it early (and so skip the evening's).
 */
const WRAP_FROM = 19 * 60 + 30;

export const assistantModule = defineModule({
  name: "assistant",
  description: "Jarvis's own records: observations, watches, briefs, journals and its activity.",
  entityTypes: ["brief", "journal"],
  events: [
    {
      kind: "jarvis.observed",
      description: "Jarvis noted something for the brief. Payload: observationId, kind, aboutId.",
    },
    {
      kind: "jarvis.watch_changed",
      description: "A watch started or ended. Payload: watchId, description, active.",
    },
  ],
  knowledge: {
    brief: async (entityId, ctx) => {
      const row = await liveEntity(ctx.db, entityId, "brief");
      return row ? describeRow(row) : null;
    },
    journal: async (entityId, ctx) => {
      const row = await liveEntity(ctx.db, entityId, "journal");
      return row ? describeRow(row) : null;
    },
  },
  routines: [briefRoutine, journalRoutine],
  actions: [
    ...turnActions,
    didAction,
    defineAction({
      name: "jarvis.observe",
      description:
        "Note something for the owner's next brief instead of interrupting them. Kinds: finding, risk, followup, fyi.",
      input: z.object({
        kind: z.enum(["finding", "risk", "followup", "fyi"]),
        text: z.string().trim().min(1).max(2000),
        aboutId: id.optional(),
        expiresInHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .optional(),
      }),
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        const oid = newId();
        await ctx.tx.insert(observation).values({
          id: oid,
          kind: i.kind,
          text: i.text,
          aboutId: i.aboutId ?? null,
          expiresAt: i.expiresInHours
            ? new Date(ctx.now.getTime() + i.expiresInHours * 3600_000)
            : null,
          createdBy: ctx.caller.principal,
          // Noted after reading outside content, it's outside content in the brief too (D58).
          origin: ctx.caller.origin,
          turnId: ctx.caller.turnId ?? null,
          createdAt: ctx.now,
        });
        ctx.emit({
          kind: "jarvis.observed",
          entityId: i.aboutId ?? null,
          payload: { observationId: oid, kind: i.kind, aboutId: i.aboutId ?? null },
        });
        // A fixed acknowledgement, so observations can't leak into replies.
        return { ack: "Noted for the brief." };
      },
    }),
    defineAction({
      name: "jarvis.watch",
      description:
        'Keep an eye out for an event and act when it happens. filter uses the filter language over {kind, entityId, actor, origin, payload}, e.g. {"and":[{"field":"kind","op":"eq","value":"task.status_changed"},{"field":"entityId","op":"eq","value":"<id>"}]}.',
      input: z.object({
        description: z.string().trim().min(3).max(500),
        filter: filterSchema,
        subjectId: id.optional(),
        expiresInHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 90)
          .default(24 * 14),
      }),
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        // A watch is a standing instruction that runs turns of its own, unrationed: outside
        // content (an email, a page) mustn't be able to leave one behind (D31, D58).
        if (ctx.caller.origin === "untrusted")
          throw new ActionError(
            "forbidden",
            "A watch can't be set up after reading outside content. Tell the owner what you'd watch for, and they can ask you to set it up.",
          );
        const wid = newId();
        await ctx.tx.insert(watch).values({
          id: wid,
          description: i.description,
          filter: i.filter,
          subjectId: i.subjectId ?? null,
          conversationId: ctx.caller.conversationId ?? null,
          createdBy: ctx.caller.principal,
          origin: ctx.caller.origin,
          createdAt: ctx.now,
          expiresAt: new Date(ctx.now.getTime() + i.expiresInHours * 3600_000),
        });
        ctx.emit({
          kind: "jarvis.watch_changed",
          payload: { watchId: wid, description: i.description, active: true },
        });
        return { watchId: wid };
      },
    }),
    defineAction({
      name: "jarvis.unwatch",
      description: "Stop a watch.",
      input: z.object({ id }),
      risk: "internal",
      async handler(i, ctx) {
        const rows = await ctx.tx
          .update(watch)
          .set({ endedAt: ctx.now })
          .where(and(eq(watch.id, i.id), isNull(watch.endedAt)))
          .returning();
        if (rows[0])
          ctx.emit({
            kind: "jarvis.watch_changed",
            payload: { watchId: i.id, description: rows[0].description, active: false },
          });
        return { ended: rows.length };
      },
    }),
    defineAction({
      name: "jarvis.watches",
      description: "List active watches.",
      input: z.object({}),
      risk: "read",
      handler: (_i, ctx) =>
        ctx.tx
          .select()
          .from(watch)
          .where(
            and(isNull(watch.endedAt), or(isNull(watch.expiresAt), gt(watch.expiresAt, ctx.now))),
          ),
    }),
    defineAction({
      name: "jarvis.activity",
      description: "Jarvis's recent turns: what triggered each, what it did, and how it ended.",
      input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      risk: "read",
      handler: (i, ctx) =>
        ctx.tx.select().from(jarvisTurn).orderBy(desc(jarvisTurn.queuedAt)).limit(i.limit),
    }),
    defineAction({
      name: "observation.list",
      description: "Observations not yet in a brief.",
      input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
      risk: "read",
      handler: (i, ctx) =>
        ctx.tx
          .select()
          .from(observation)
          .where(isNull(observation.surfacedAt))
          .orderBy(desc(observation.createdAt))
          .limit(i.limit),
    }),
    defineAction({
      name: "brief.publish",
      description: "Publish the brief for a date: it's saved as a record and pinned in the inbox.",
      input: z.object({ markdown: z.string().min(1).max(50_000), date }),
      risk: "internal",
      async handler(i, ctx) {
        const title = `Brief for ${i.date}`;
        const existing = await findByTitle(ctx.tx, "brief", title);
        const row = existing
          ? await updateEntity(ctx, existing.id, { body: i.markdown })
          : await createEntity(ctx, { type: "brief", title, body: i.markdown });
        await ctx.tx
          .update(observation)
          .set({ surfacedAt: ctx.now })
          .where(isNull(observation.surfacedAt));
        await createNotification(ctx, {
          kind: "brief",
          title,
          entityId: row.id,
          urgency: "normal",
          dedupeKey: `brief:${i.date}`,
        });
        return { id: row.id };
      },
    }),
    defineAction({
      name: "journal.write",
      description: "Write (or replace) the journal entry for a date.",
      input: z.object({ markdown: z.string().min(1).max(50_000), date }),
      risk: "internal",
      async handler(i, ctx) {
        const title = `Journal ${i.date}`;
        const existing = await findByTitle(ctx.tx, "journal", title);
        const row = existing
          ? await updateEntity(ctx, existing.id, { body: i.markdown })
          : await createEntity(ctx, { type: "journal", title, body: i.markdown });
        // The evening's "Your day" card, once a day: not for an old entry written again.
        const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
        if (
          i.date >= addLocalDays(localDate(ctx.now, timeZone), -1) &&
          ctx.now >= atLocal(i.date, WRAP_FROM, timeZone)
        )
          await createNotification(ctx, {
            kind: "wrap",
            title: "Your day",
            body: await tomorrowAtAGlance(ctx.tx, i.date, timeZone),
            entityId: row.id,
            urgency: "normal",
            dedupeKey: `wrap:${i.date}`,
          });
        return { id: row.id };
      },
    }),
  ],
  reflexes: [
    {
      name: "jarvis.watches",
      description: "When something Jarvis was asked to watch for happens, it acts on it.",
      mode: "reactive",
      on: ["*"],
      async run(event, ctx) {
        if (event.kind === "jarvis.watch_changed" || event.kind.startsWith("conversation."))
          return [];
        const active = await ctx.db
          .select()
          .from(watch)
          .where(
            and(isNull(watch.endedAt), or(isNull(watch.expiresAt), gt(watch.expiresAt, ctx.now))),
          );
        const view = {
          kind: event.kind,
          entityId: event.entityId,
          actor: event.actor,
          origin: event.origin,
          payload: event.payload,
        };
        // The turn is no more trusted than what set the watch up, or than what happened; text
        // from either that's outside content is marked as such (D58).
        const payload = JSON.stringify(event.payload).slice(0, 2000);
        const what = event.origin === "untrusted" ? asUntrusted(payload, event.kind) : payload;
        return active
          .filter((w) => matches(w.filter as never, view))
          .map((w) => {
            const setUpOutside = w.origin === "untrusted";
            const asked = setUpOutside ? asUntrusted(w.description, "watch") : w.description;
            return {
              kind: "turn" as const,
              trigger: "watch" as const,
              lane: "fast" as const,
              origin: w.origin,
              ...(setUpOutside || event.origin === "untrusted" ? { untrusted: true } : {}),
              conversationId: w.conversationId,
              subjectId: w.subjectId,
              dedupeKey: `watch:${w.id}:${event.id}`,
              context: { watchId: w.id },
              prompt: `Something you were watching for happened: ${asked}\nEvent ${event.kind} at ${formatDateTime(event.at)}: ${what}\nDecide what to do. End the watch with jarvis_unwatch if it's no longer needed.`,
            };
          });
      },
    },
  ],
  async digest(ctx): Promise<DigestItem[]> {
    const items: DigestItem[] = [];
    const turns = await ctx.db
      .select({ t: jarvisTurn, taintedAt: conversation.taintedAt })
      .from(jarvisTurn)
      .leftJoin(conversation, eq(conversation.entityId, jarvisTurn.conversationId))
      .where(and(gte(jarvisTurn.finishedAt, ctx.since), eq(jarvisTurn.outcome, "act")))
      .orderBy(desc(jarvisTurn.finishedAt))
      .limit(20);
    for (const { t, taintedAt } of turns) {
      if (t.reply)
        items.push({
          bucket: "handled",
          text: t.reply.split("\n")[0]!.slice(0, 200),
          entityId: t.subjectId,
          // A turn that started trusted and then read an email can quote it in its reply: its
          // conversation was tainted by the time it finished (D58).
          outside:
            t.origin === "untrusted" ||
            (taintedAt !== null && t.finishedAt !== null && taintedAt <= t.finishedAt),
        });
    }
    const obs = await ctx.db
      .select()
      .from(observation)
      .where(isNull(observation.surfacedAt))
      .orderBy(desc(observation.createdAt))
      .limit(20);
    for (const o of obs) {
      if (o.expiresAt && o.expiresAt < ctx.now) continue;
      const outside = o.origin === "untrusted" || writtenOutside(o.createdBy);
      items.push({ bucket: "fyi", text: o.text, entityId: o.aboutId, outside });
    }
    return items;
  },
});
