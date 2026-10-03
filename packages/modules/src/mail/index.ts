// Email (M2): your Gmail accounts in one triage inbox, split into Signal and Noise, threaded by
// RFC headers, with people built from the mail you send (PLAN.md section 8.1, D15).
import { localDate } from "@hearth/core";
import { mailAccount, mailMessage, mailSenderRule, mailThread } from "@hearth/db";
import {
  ActionError,
  type DigestItem,
  defineAction,
  defineModule,
  getSetting,
  type ReflexDef,
} from "@hearth/kernel";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { id, isoDateTime } from "../shared.ts";
import { describeDraft, draftActions } from "./drafts.ts";
import { changeFlags, pendingChanges, recomputeThread } from "./flags.ts";
import { normalizePattern, senderPatterns } from "./people.ts";
import { syncMail } from "./sync.ts";
import { listThreads, loadThread, searchThreads, threadText, who } from "./views.ts";
import { followUpRoutine, waitingActions, waitingDigest } from "./waiting.ts";

export { BLOB_SERVICE, BlobStore, blobsFromEnv } from "./blobs.ts";
export type { DraftView } from "./drafts.ts";
export type { MessageView, ThreadSummary, ThreadView } from "./views.ts";
export { messageAttachment, messageHtml } from "./views.ts";

const ids = z.array(id).min(1).max(500).describe("Conversation ids.");
const lane = z.enum(["signal", "noise"]);

const syncFailed: ReflexDef = {
  name: "mail.sync_failed",
  description: "When mail stops syncing, you get one notice a day about it.",
  mode: "always",
  on: ["mail.sync_failed"],
  async run(event, ctx) {
    const rules = await getSetting(ctx.db, "owner.dayRules");
    const errors = (event.payload.errors as string[] | undefined) ?? [];
    return [
      {
        kind: "tell",
        notification: {
          kind: "system.alert",
          title: "Mail isn't syncing",
          body: errors.join("\n").slice(0, 1000),
          urgency: "normal",
          dedupeKey: `mail.sync_failed:${localDate(event.at, rules.timeZone)}`,
        },
      },
    ];
  },
};

const changeFailed: ReflexDef = {
  name: "mail.change_failed",
  description:
    "When Gmail refuses a change you made (an archive, a star), you're told it was put back.",
  mode: "always",
  on: ["mail.change_failed"],
  run(event) {
    return [
      {
        kind: "tell",
        notification: {
          kind: "system.alert",
          title: "A mail change didn't stick",
          body: `Gmail refused it, so Hearth put the conversation back as it was: ${String(event.payload.error ?? "")}`,
          entityId: event.entityId,
          urgency: "quiet",
          dedupeKey: `mail.change_failed:${event.id}`,
        },
      },
    ];
  },
};

/** Flag changes on whole conversations, done here at once and synced to the provider after. */
function flagAction(
  name: string,
  description: string,
  flags: (i: Record<string, unknown>) => { add: string[]; remove: string[] },
  extra: z.ZodRawShape = {},
  risk: "internal" | "destructive" = "internal",
) {
  return defineAction({
    name,
    description,
    input: z.object({ ids, ...extra }),
    risk,
    summarize: (i: { ids: string[] }) =>
      `${description.split(".")[0]} (${i.ids.length} conversation${i.ids.length === 1 ? "" : "s"})`,
    async handler(i, ctx) {
      const { add, remove } = flags(i as Record<string, unknown>);
      return { changed: await changeFlags(ctx, i.ids, add, remove) };
    },
  });
}

export const mailModule = defineModule({
  name: "mail",
  description: "Email: your Gmail accounts in one inbox, split into Signal and Noise.",
  entityTypes: ["email_thread", "email", "email_draft"],
  // Mail is written by other people: reading it makes the rest of Jarvis's turn untrusted (D25).
  outsideTypes: ["email_thread", "email", "email_draft"],
  events: [
    {
      kind: "mail.received",
      description: "New mail arrived (not mail you sent). Payload: threadId, from, subject.",
    },
    { kind: "mail.changed", description: "Conversations were archived, starred, read or moved." },
    {
      kind: "mail.change_failed",
      description:
        "The provider refused a change, so it was rolled back. Payload: add, remove, error.",
    },
    { kind: "mail.sync_failed", description: "Syncing mail failed. Payload: errors." },
    { kind: "mail.sent", description: "An email was sent. Payload: to, subject." },
  ],
  kernelEvents: ["entity.created", "entity.updated", "link.added"],
  knowledge: {
    email_draft: describeDraft,
    async email_thread(entityId, ctx) {
      const t = await loadThread(ctx.db, entityId);
      return t ? threadText(t) : null;
    },
    async email(entityId, ctx) {
      const [m] = await ctx.db
        .select({ threadId: mailMessage.threadId })
        .from(mailMessage)
        .where(eq(mailMessage.entityId, entityId));
      const t = m ? await loadThread(ctx.db, m.threadId) : null;
      return t ? threadText({ ...t, messages: t.messages.filter((x) => x.id === entityId) }) : null;
    },
  },
  actions: [
    defineAction({
      name: "mail.threads",
      description:
        "List email conversations, newest first: the inbox (default), starred, sent, all, or trash. Filter by lane (signal or noise), account or unread.",
      input: z.object({
        view: z.enum(["inbox", "starred", "sent", "all", "trash"]).default("inbox"),
        lane: lane.optional(),
        account: z.string().email().optional(),
        unread: z.boolean().optional(),
        waiting: z
          .enum(["you", "them"])
          .optional()
          .describe("you: needs the owner's reply. them: the owner wrote last and is waiting."),
        before: isoDateTime.optional().describe("For the next page: the last one's lastMessageAt."),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      risk: "read",
      // Subjects and previews are written by whoever sent the mail.
      external: true,
      handler: (i, ctx) =>
        listThreads(ctx.tx, { ...i, before: i.before ? new Date(i.before) : undefined }),
    }),
    defineAction({
      name: "mail.search",
      description: "Search email by words in the subject or the messages, newest first.",
      input: z.object({
        query: z.string().trim().min(1).max(300),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      risk: "read",
      external: true,
      handler: (i, ctx) => searchThreads(ctx.tx, i.query, i.limit),
    }),
    defineAction({
      name: "mail.thread",
      description:
        "One email conversation in full: every message's text, sender and attachments. Give the conversation's id or any of its messages' ids.",
      input: z.object({ id }),
      risk: "read",
      external: true,
      async handler(i, ctx) {
        const [m] = await ctx.tx
          .select({ threadId: mailMessage.threadId })
          .from(mailMessage)
          .where(eq(mailMessage.entityId, i.id));
        const t = await loadThread(ctx.tx, m?.threadId ?? i.id);
        if (!t) throw new ActionError("not_found", "No email conversation with that id.");
        return t;
      },
    }),
    flagAction(
      "mail.archive",
      "Archive conversations: out of the inbox, kept in All mail.",
      () => ({
        add: [],
        remove: ["INBOX"],
      }),
    ),
    flagAction("mail.unarchive", "Move conversations back to the inbox.", () => ({
      add: ["INBOX"],
      remove: ["TRASH"],
    })),
    flagAction(
      "mail.mark_read",
      "Mark conversations read, or unread with read: false.",
      (i) => (i.read === false ? { add: ["UNREAD"], remove: [] } : { add: [], remove: ["UNREAD"] }),
      { read: z.boolean().default(true) },
    ),
    flagAction(
      "mail.star",
      "Star conversations, or unstar them with starred: false.",
      (i) =>
        i.starred === false ? { add: [], remove: ["STARRED"] } : { add: ["STARRED"], remove: [] },
      { starred: z.boolean().default(true) },
    ),
    flagAction(
      "mail.trash",
      "Move conversations to the trash. The provider deletes them for good after 30 days.",
      () => ({ add: ["TRASH"], remove: ["INBOX"] }),
      {},
      "destructive",
    ),
    defineAction({
      name: "mail.set_lane",
      description:
        "Send all mail from an address or a whole domain to Signal or Noise from now on, and move what's in the inbox from them now.",
      input: z.object({
        sender: z
          .string()
          .min(3)
          .max(320)
          .describe('An address ("news@shop.example") or a domain ("shop.example").'),
        lane,
      }),
      risk: "internal",
      summarize: (i) => `Mail from ${i.sender} goes to ${i.lane === "noise" ? "Noise" : "Signal"}`,
      async handler(i, ctx) {
        const pattern = normalizePattern(i.sender);
        if (!pattern)
          throw new ActionError("invalid_input", "That isn't an email address or a domain.");
        await ctx.tx
          .insert(mailSenderRule)
          .values({ pattern, lane: i.lane, createdAt: ctx.now })
          .onConflictDoUpdate({
            target: mailSenderRule.pattern,
            set: { lane: i.lane, createdAt: ctx.now },
          });
        // Conversations in the inbox from that sender move now; ones you've written in stay Signal.
        const inbox = await ctx.tx
          .select({
            id: mailThread.entityId,
            lane: mailThread.lane,
            out: mailThread.lastOutboundAt,
            from: mailMessage.fromAddress,
          })
          .from(mailThread)
          .innerJoin(mailMessage, eq(mailMessage.threadId, mailThread.entityId))
          .where(and(eq(mailThread.inInbox, true), eq(mailMessage.outbound, false)));
        const moving = [
          ...new Set(
            inbox
              .filter((t) => t.lane !== i.lane && !(i.lane === "noise" && t.out))
              .filter((t) => senderPatterns(t.from).includes(pattern))
              .map((t) => t.id),
          ),
        ];
        if (moving.length) {
          await ctx.tx
            .update(mailThread)
            .set({ lane: i.lane })
            .where(inArray(mailThread.entityId, moving));
          // Who each one waits on depends on its lane.
          for (const id of moving) await recomputeThread(ctx, id);
          ctx.emit({ kind: "mail.changed", payload: { lane: i.lane, moved: moving.length } });
        }
        return { pattern, lane: i.lane, moved: moving.length };
      },
    }),
    defineAction({
      name: "mail.rules",
      description: "Your Signal and Noise rules by sender.",
      input: z.object({}),
      risk: "read",
      handler: (_i, ctx) => ctx.tx.select().from(mailSenderRule).orderBy(mailSenderRule.pattern),
    }),
    defineAction({
      name: "mail.remove_rule",
      description: "Forget a Signal or Noise rule.",
      input: z.object({ pattern: z.string().min(1).max(320) }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const gone = await ctx.tx
          .delete(mailSenderRule)
          .where(eq(mailSenderRule.pattern, i.pattern))
          .returning();
        return { removed: gone.length };
      },
    }),
    defineAction({
      name: "mail.accounts",
      description: "Your mail accounts, when each last synced, and anything wrong.",
      input: z.object({}),
      risk: "read",
      async handler(_i, ctx) {
        const rows = await ctx.tx.select().from(mailAccount).orderBy(mailAccount.address);
        return Promise.all(
          rows.map(async (a) => ({
            address: a.address,
            provider: a.provider,
            syncedAt: a.syncedAt,
            lastError: a.lastError,
            firstSyncDone: a.cursor !== null && !("pageToken" in (a.cursor ?? {})),
            pendingChanges: await pendingChanges(ctx.tx, a.id),
          })),
        );
      },
    }),
    defineAction({
      name: "mail.sync",
      description: "Send queued changes to the mail provider and bring in new mail now.",
      input: z.object({}),
      risk: "internal",
      // Only as the integration, so the news it emits (mail.received) is always untrusted.
      callers: ["integration"],
      handler: (_i, ctx) => syncMail(ctx),
    }),
    ...draftActions,
    ...waitingActions,
  ],
  routines: [followUpRoutine],
  reflexes: [syncFailed, changeFailed],
  async digest(ctx): Promise<DigestItem[]> {
    const rows = await listThreads(ctx.db, {
      view: "inbox",
      lane: "signal",
      unread: true,
      limit: 20,
    });
    const fresh = rows.filter((t) => t.lastMessageAt >= ctx.since);
    return [
      ...(await waitingDigest(ctx)),
      ...fresh.slice(0, 8).map((t) => ({
        bucket: "fyi" as const,
        text: `Email from ${t.participants[0] ? who(t.participants[0]) : "someone"}: ${t.subject}`,
        entityId: t.id,
        outside: true,
      })),
    ];
  },
});
