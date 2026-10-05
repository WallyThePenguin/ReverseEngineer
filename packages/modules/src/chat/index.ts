// Chat with Jarvis, and comment threads on any record. Jarvis answers chat messages and
// @mentions wherever they appear. Its own routines' runs stay out of the conversation list.
import { formatDateTime } from "@hearth/core";
import { conversation, conversationLog, entity, jarvisTurn } from "@hearth/db";
import {
  createEntity,
  defineAction,
  defineModule,
  notFound,
  requireEntity,
  updateEntity,
} from "@hearth/kernel";
import { and, asc, desc, eq, gt, ilike, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { body, describeRow, id, liveEntity, preview } from "../shared.ts";
import { appendLog, routeLane } from "./log.ts";
import { answerMention } from "./mention.ts";

const lane = z.enum(["fast", "deep"]);

/** Words to find in a title as typed: % and _ match themselves, not anything. */
const likeText = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A paired device (the desktop app) only sees the conversations it started (D42). */
const deviceMay = (via: string, startedVia: string | null | undefined) =>
  via !== "device" || startedVia === "device";

export const chatModule = defineModule({
  name: "chat",
  description: "Conversations with Jarvis and comment threads on any record.",
  entityTypes: ["conversation", "comment"],
  events: [
    {
      kind: "chat.message_posted",
      description: "You wrote to Jarvis. Payload: conversationId, text, lane, idx.",
    },
    {
      kind: "conversation.appended",
      description: "A conversation log grew. Payload: conversationId, idx, kind, turnId.",
    },
  ],
  knowledge: {
    async conversation(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "conversation");
      if (!row) return null;
      const log = await ctx.db
        .select()
        .from(conversationLog)
        .where(eq(conversationLog.conversationId, entityId))
        .orderBy(desc(conversationLog.idx))
        .limit(20);
      const lines = log
        .reverse()
        .filter((l) => l.kind === "user_message" || l.kind === "assistant_message")
        .map(
          (l) =>
            `- ${l.kind === "user_message" ? "You" : "Jarvis"} (${formatDateTime(l.at)}): ${preview(String(l.payload.text ?? ""), 500)}`,
        );
      return describeRow(row, [], lines.length ? `## Latest messages\n${lines.join("\n")}` : "");
    },
    async comment(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "comment");
      if (!row) return null;
      const parent = row.parentId ? await liveEntity(ctx.db, row.parentId) : undefined;
      return describeRow(
        { ...row, title: `Comment${parent ? ` on "${parent.title}"` : ""}` },
        parent ? [`on ${parent.type} ${parent.id}`] : [],
      );
    },
  },
  actions: [
    defineAction({
      name: "conversation.create",
      description: "Start a new conversation with Jarvis.",
      input: z.object({ title: z.string().trim().max(200).optional(), subjectId: id.optional() }),
      risk: "internal",
      async handler(i, ctx) {
        const e = await createEntity(ctx, {
          type: "conversation",
          title: i.title || "New conversation",
        });
        await ctx.tx
          .insert(conversation)
          .values({ entityId: e.id, subjectId: i.subjectId ?? null });
        return e;
      },
    }),
    defineAction({
      name: "conversation.list",
      description:
        "List conversations with Jarvis, most recent first, optionally those whose title has some words. Jarvis's own routine runs (the brief, prep, drafting) are left out unless routines is true.",
      input: z.object({
        limit: z.number().int().min(1).max(100).default(30),
        query: z.string().trim().max(200).optional(),
        routines: z.boolean().default(false),
      }),
      risk: "read",
      async handler(i, ctx) {
        // A routine's run: no record it's about, and only Jarvis's own turns in it. A chat you
        // started, or one you wrote in afterwards, has a turn that answers you, so it stays.
        const routineRun = sql`(${conversation.subjectId} IS NULL AND (SELECT bool_and(${jarvisTurn.mode} = 'proactive') FROM ${jarvisTurn} WHERE ${jarvisTurn.conversationId} = ${entity.id}))`;
        return ctx.tx
          .select({
            id: entity.id,
            title: entity.title,
            updatedAt: entity.updatedAt,
            subjectId: conversation.subjectId,
            lastTurnAt: conversation.lastTurnAt,
          })
          .from(entity)
          .innerJoin(conversation, eq(conversation.entityId, entity.id))
          .where(
            and(
              isNull(entity.deletedAt),
              i.query ? ilike(entity.title, `%${likeText(i.query)}%`) : undefined,
              i.routines ? undefined : sql`${routineRun} IS NOT TRUE`,
            ),
          )
          .orderBy(desc(entity.updatedAt))
          .limit(i.limit);
      },
    }),
    defineAction({
      name: "conversation.rename",
      description: "Rename a conversation with Jarvis.",
      input: z.object({ id, title: z.string().trim().min(1).max(200) }),
      risk: "internal",
      async handler(i, ctx) {
        const [c] = await ctx.tx
          .select({ startedVia: conversation.startedVia })
          .from(conversation)
          .where(eq(conversation.entityId, i.id));
        if (!c || !deviceMay(ctx.caller.via, c.startedVia)) throw notFound("Conversation");
        return updateEntity(ctx, i.id, { title: i.title }, { type: "conversation" });
      },
    }),
    defineAction({
      name: "conversation.get",
      description: "Get a conversation and its full log.",
      input: z.object({ id, afterIdx: z.number().int().optional() }),
      risk: "read",
      async handler(i, ctx) {
        const e = await requireEntity(ctx.tx, i.id, "conversation");
        const [c] = await ctx.tx.select().from(conversation).where(eq(conversation.entityId, i.id));
        if (!deviceMay(ctx.caller.via, c?.startedVia)) throw notFound("Conversation");
        const log = await ctx.tx
          .select()
          .from(conversationLog)
          .where(eq(conversationLog.conversationId, i.id))
          .orderBy(asc(conversationLog.idx));
        return {
          conversation: {
            ...e,
            subjectId: c?.subjectId ?? null,
            // Once it has read outside content, Jarvis asks more here: the app says why (D58).
            taintedAt: c?.taintedAt ?? null,
            taintSource: c?.taintSource ?? null,
          },
          log: log.filter((l) => i.afterIdx === undefined || l.idx > i.afterIdx),
        };
      },
    }),
    defineAction({
      name: "chat.send",
      description:
        "Send Jarvis a message. Starts a new conversation when no conversationId is given.",
      input: z.object({
        conversationId: id.optional(),
        text: z.string().trim().min(1).max(20_000),
        lane: lane.optional(),
        /** Words the desktop app transcribed (D46): the device holding its token chose them, so
         * Jarvis's turn runs untrusted, like anything else that device starts. */
        heard: z.boolean().optional(),
      }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        let conversationId = i.conversationId;
        if (conversationId) {
          await requireEntity(ctx.tx, conversationId, "conversation");
          const [c] = await ctx.tx
            .select({ startedVia: conversation.startedVia })
            .from(conversation)
            .where(eq(conversation.entityId, conversationId));
          if (!deviceMay(ctx.caller.via, c?.startedVia)) throw notFound("Conversation");
        } else {
          const e = await createEntity(ctx, {
            type: "conversation",
            title: preview(i.text, 60) || "New conversation",
          });
          await ctx.tx
            .insert(conversation)
            .values({ entityId: e.id, startedVia: ctx.caller.via === "device" ? "device" : null });
          conversationId = e.id;
        }
        const chosen = i.lane ?? routeLane(i.text);
        // Heard, or sent by a device on its own say-so (D42): kept as such, so the nightly memory
        // update doesn't take it for your words (D58).
        const heard = i.heard === true || ctx.caller.origin === "untrusted";
        const [idx] = await appendLog(
          ctx.tx,
          conversationId,
          [
            {
              kind: "user_message",
              payload: { text: i.text, by: ctx.caller.principal, ...(heard ? { heard } : {}) },
            },
          ],
          ctx.now,
        );
        ctx.emit({
          kind: "conversation.appended",
          entityId: conversationId,
          payload: { conversationId, idx, kind: "user_message" },
        });
        ctx.emit({
          kind: "chat.message_posted",
          entityId: conversationId,
          payload: { conversationId, text: i.text, lane: chosen, idx, heard: i.heard === true },
        });
        return { conversationId, idx };
      },
    }),
    defineAction({
      name: "comment.create",
      description:
        "Comment on any record. @mention Jarvis in the comment to ask it something there.",
      input: z.object({ parentId: id, body: body.min(1) }),
      risk: "internal",
      handler: (i, ctx) =>
        createEntity(ctx, { type: "comment", title: "", body: i.body, parentId: i.parentId }),
    }),
    defineAction({
      name: "comment.update",
      description: "Edit a comment.",
      input: z.object({ id, body: body.min(1) }),
      risk: "internal",
      handler: (i, ctx) => updateEntity(ctx, i.id, { body: i.body }, { type: "comment" }),
    }),
    defineAction({
      name: "comment.list",
      description: "List the comments on a record, oldest first.",
      input: z.object({ parentId: id }),
      risk: "read",
      async handler(i, ctx) {
        const parent = await liveEntity(ctx.tx, i.parentId);
        if (!parent) throw notFound("Record");
        return ctx.tx
          .select()
          .from(entity)
          .where(
            and(
              eq(entity.parentId, i.parentId),
              eq(entity.type, "comment"),
              isNull(entity.deletedAt),
            ),
          )
          .orderBy(asc(entity.createdAt));
      },
    }),
  ],
  reflexes: [
    {
      name: "chat.reply",
      description: "Jarvis answers every message you send it.",
      mode: "reactive",
      on: ["chat.message_posted"],
      async run(event, ctx) {
        const p = event.payload as {
          conversationId: string;
          text: string;
          lane: "fast" | "deep";
          heard?: boolean;
          idx: number;
        };
        // You pressed Stop before Jarvis saw this (it was down): let it go (D54).
        const [stopped] = await ctx.db
          .select({ idx: conversationLog.idx })
          .from(conversationLog)
          .where(
            and(
              eq(conversationLog.conversationId, p.conversationId),
              eq(conversationLog.kind, "notice"),
              gt(conversationLog.idx, p.idx),
              sql`${conversationLog.payload}->>'stopped' = 'true'`,
            ),
          )
          .limit(1);
        if (stopped) return [];
        return [
          {
            kind: "turn",
            trigger: "chat",
            ...(p.heard ? { untrusted: true } : {}),
            lane: p.lane,
            conversationId: p.conversationId,
            prompt: p.text,
            dedupeKey: `chat:${event.id}`,
          },
        ];
      },
    },
    answerMention,
  ],
});

export { appendLog, type LogEntry, type LogKind, routeLane } from "./log.ts";
