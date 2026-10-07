// Drafts. Anyone may write one (you, or Jarvis drafting a reply); sending one is `mail.send`
// (send.ts), which is outward and waits for your yes.
import { PRINCIPAL } from "@hearth/core";
import {
  type DbOrTx,
  entity,
  jarvisTurn,
  type MailAddress,
  mailAccount,
  mailDraft,
  mailMessage,
  mailThread,
} from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  createEntity,
  defineAction,
  type ReadContext,
  trashEntity,
  updateEntity,
} from "@hearth/kernel";
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { body, id, mustSayBase } from "../shared.ts";
import { addresses, clean, draftSubject, parseAll, withinLimits } from "./addresses.ts";
import { once } from "./copies.ts";
import { newMessageId } from "./mime.ts";
import { addressKey, yourAddresses } from "./mine.ts";
import { checkRecipients } from "./recipients.ts";
import { loadThread } from "./views.ts";
import { threadsToDraft } from "./waiting.ts";

/** Address first, so a name can't pass for another recipient: "ana@x.example (Ana Silva)". */
const shown = (a: MailAddress) => (a.name ? `${a.address} (${a.name})` : a.address);
/** Subjects on one line, without characters that change how the line reads. */
export const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ");

export interface DraftView {
  id: string;
  /** The address it goes from; null for one kept from a disconnected account, until you pick. */
  account: string | null;
  threadId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  updatedAt: Date;
  /** Raised by every change: what mail.draft_update's baseVersion and mail.send's version name. */
  version: number;
  /** Who started it: Jarvis, or you (yourself, or a tool working for you). */
  by: "jarvis" | "owner";
}

export async function loadDraft(db: DbOrTx, draftId: string): Promise<DraftView | null> {
  const [row] = await db
    .select({ d: mailDraft, e: entity, account: mailAccount.address })
    .from(mailDraft)
    .innerJoin(entity, eq(entity.id, mailDraft.entityId))
    .leftJoin(mailAccount, eq(mailAccount.id, mailDraft.accountId))
    .where(and(eq(mailDraft.entityId, draftId), isNull(entity.deletedAt)));
  if (!row) return null;
  return {
    id: row.e.id,
    account: row.account,
    threadId: row.d.threadId,
    to: row.d.toAddresses,
    cc: row.d.ccAddresses,
    bcc: row.d.bccAddresses,
    subject: row.e.title,
    text: row.e.body ?? "",
    updatedAt: row.e.updatedAt,
    version: row.d.version,
    by: row.e.createdBy === PRINCIPAL.jarvis ? "jarvis" : "owner",
  };
}

/** What sending a draft would send, as the approval card shows it. */
export function snapshotOf(d: DraftView) {
  return {
    from: d.account ?? "",
    to: d.to.map(shown),
    cc: d.cc.map(shown),
    bcc: d.bcc.map(shown),
    subject: d.subject,
    text: d.text,
  };
}
export type Snapshot = ReturnType<typeof snapshotOf>;

export const snapshotSchema = z
  .object({
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    subject: z.string(),
    text: z.string(),
  })
  .describe("Filled in by Hearth: what will be sent. Leave it out.");

/** The account a new message goes from: the one named, or your only (or first) one. */
async function accountFor(ctx: ActionContext, wanted?: string) {
  const rows = await ctx.tx.select().from(mailAccount).orderBy(asc(mailAccount.address));
  const row = wanted ? rows.find((r) => r.address === wanted.toLowerCase()) : rows[0];
  // One no longer connected is a From to change, not a draft that's gone.
  if (!row)
    throw new ActionError(
      wanted ? "invalid_input" : "unavailable",
      wanted
        ? `No mail account ${wanted} is connected. Pick another From.`
        : "No mail account is connected. Connect Gmail in Settings.",
    );
  return row;
}

/** Who a reply goes to, and the headers that keep it in the conversation. */
async function replyHeaders(ctx: ActionContext, threadId: string, all: boolean) {
  const t = await loadThread(ctx.tx, threadId);
  if (!t) throw new ActionError("not_found", "No email conversation with that id.");
  const rows = await ctx.tx
    .select()
    .from(mailMessage)
    .where(eq(mailMessage.threadId, threadId))
    .orderBy(asc(mailMessage.sentAt), asc(mailMessage.entityId));
  // Each email once, as the conversation shows it: a copy that isn't shown has no say.
  const shown = once(rows);
  const last = shown.findLast((m) => !m.outbound) ?? shown.at(-1);
  if (!last) throw new ActionError("not_found", "That conversation has no messages.");
  const [account] = await ctx.tx
    .select()
    .from(mailAccount)
    .where(eq(mailAccount.id, last.accountId));
  const self = account!.address;
  // A reply never goes to you: your own email (cc'd to another of yours, say) answers its people.
  const mine = await yourAddresses(ctx.tx);
  const yours = (a: MailAddress) => mine.has(addressKey(a.address));
  const from: MailAddress = {
    address: last.fromAddress,
    ...(last.fromName ? { name: last.fromName } : {}),
  };
  const fromYou = last.outbound || yours(from);
  const to = (fromYou ? last.toAddresses : [last.replyTo ? { address: last.replyTo } : from])
    .map(clean)
    .filter((a) => !yours(a));
  const taken = new Set([self, ...to.map((a) => a.address)]);
  const cc = all
    ? [...last.toAddresses, ...last.ccAddresses].map(clean).filter((a) => {
        if (taken.has(a.address) || yours(a)) return false;
        taken.add(a.address);
        return true;
      })
    : [];
  return {
    account,
    to,
    cc,
    subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`,
    inReplyTo: last.messageId,
    refs: [...last.refs, last.messageId].slice(-20),
  };
}

/**
 * Jarvis writes one reply to each message: two runs that both saw the same email (the morning's
 * and the day's, or a heartbeat that went round twice) leave one draft, not two. One you threw
 * away doesn't count, so asking again writes a fresh one.
 */
async function oneDraftEach(ctx: ActionContext, threadId: string): Promise<void> {
  const [mine] = await ctx.tx
    .select({ id: mailDraft.entityId })
    .from(mailDraft)
    .innerJoin(entity, eq(entity.id, mailDraft.entityId))
    .innerJoin(mailThread, eq(mailThread.entityId, mailDraft.threadId))
    .where(
      and(
        eq(mailDraft.threadId, threadId),
        eq(entity.createdBy, PRINCIPAL.jarvis),
        isNull(entity.deletedAt),
        gte(entity.createdAt, mailThread.waitingSince),
      ),
    )
    .limit(1);
  if (mine)
    throw new ActionError(
      "conflict",
      `There's already a draft of yours for this conversation since its last message (draft ${mine.id}). Leave it: the owner will see it in Mail.`,
    );
}

/** Jarvis's own rounds of reply drafts, as opposed to a draft you asked for. */
const ON_ITS_OWN = new Set(["heartbeat", "reply_drafts"]);

/**
 * In a round Jarvis does on its own, the conversation must still need a draft when it writes:
 * you may have replied, archived it or pressed Reply since the round began.
 */
async function stillNeedsDraft(ctx: ActionContext, threadId: string): Promise<void> {
  if (!ctx.caller.turnId) return;
  const [turn] = await ctx.tx
    .select({ context: jarvisTurn.context })
    .from(jarvisTurn)
    .where(eq(jarvisTurn.id, ctx.caller.turnId));
  if (!ON_ITS_OWN.has(String(turn?.context.routine))) return;
  if ((await threadsToDraft({ db: ctx.tx, now: ctx.now }, threadId)).length > 0) return;
  throw new ActionError(
    "conflict",
    "The owner has this conversation in hand now (they replied, archived it or started a reply), or it needs no reply. Leave it.",
  );
}

export const draftActions = [
  defineAction({
    name: "mail.draft",
    description:
      "Write an email draft. To reply, give threadId (recipients, subject and threading come from the conversation; replyAll adds everyone on it). Nothing is sent: the owner sends it, or you ask with mail_send.",
    input: z.object({
      threadId: id.optional(),
      replyAll: z.boolean().default(false),
      to: addresses.optional(),
      cc: addresses.optional(),
      bcc: addresses.optional(),
      subject: draftSubject.optional(),
      text: body,
      account: z.string().email().optional().describe("Which of the owner's accounts it's from."),
    }),
    risk: "internal",
    async handler(i, ctx) {
      if (i.threadId && ctx.caller.principal === PRINCIPAL.jarvis) {
        await oneDraftEach(ctx, i.threadId);
        await stillNeedsDraft(ctx, i.threadId);
      }
      const typed = ctx.caller.kind === "owner";
      if (!typed) withinLimits(i);
      const asked = {
        to: parseAll(i.to, typed),
        cc: parseAll(i.cc, typed),
        bcc: parseAll(i.bcc, typed),
      };
      await checkRecipients(ctx, i.threadId ?? null, asked);
      const reply = i.threadId ? await replyHeaders(ctx, i.threadId, i.replyAll) : null;
      const account = reply?.account ?? (await accountFor(ctx, i.account));
      const subject = i.subject ?? reply?.subject ?? "";
      const draft = await createEntity(ctx, { type: "email_draft", title: subject, body: i.text });
      await ctx.tx.insert(mailDraft).values({
        entityId: draft.id,
        accountId: account.id,
        threadId: i.threadId ?? null,
        toAddresses: asked.to ?? reply?.to ?? [],
        ccAddresses: asked.cc ?? reply?.cc ?? [],
        bccAddresses: asked.bcc ?? [],
        inReplyTo: reply?.inReplyTo ?? null,
        refs: reply?.refs ?? [],
        messageId: newMessageId(account.address),
      });
      // Remembered on the conversation, so one you throw away isn't written again (waiting.ts).
      if (i.threadId && ctx.caller.principal === PRINCIPAL.jarvis)
        await ctx.tx
          .update(mailThread)
          .set({ draftedAt: ctx.now })
          .where(eq(mailThread.entityId, i.threadId));
      return loadDraft(ctx.tx, draft.id);
    },
  }),
  defineAction({
    name: "mail.draft_update",
    description:
      "Change a draft: recipients, subject, text, or the account it goes from. Pass baseVersion, the version you read with mail.drafts; leave out what stays the same.",
    input: z.object({
      id,
      to: addresses.optional(),
      cc: addresses.optional(),
      bcc: addresses.optional(),
      subject: draftSubject.optional(),
      text: body.optional(),
      account: z.string().email().optional().describe("Which of the owner's accounts it's from."),
      baseVersion: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("The version you read. If the draft changed since, nothing is saved."),
    }),
    risk: "internal",
    async handler(i, ctx) {
      // Never over newer text: the owner may have typed since.
      if (i.baseVersion === undefined && mustSayBase(ctx.caller))
        throw new ActionError("invalid_input", "Pass baseVersion: the version from mail.drafts.");
      // Held until this change is in, so two saves on one version can't both pass.
      await ctx.tx.select().from(mailDraft).where(eq(mailDraft.entityId, i.id)).for("update");
      const before = await loadDraft(ctx.tx, i.id);
      if (!before) throw new ActionError("not_found", "No draft with that id.");
      if (i.baseVersion !== undefined && i.baseVersion !== before.version)
        throw new ActionError(
          "conflict",
          "The draft changed since you read it (the owner, Jarvis or another screen). Read it again with mail.drafts and redo your change on that version.",
        );
      const typed = ctx.caller.kind === "owner";
      if (!typed) withinLimits(i);
      const to = parseAll(i.to, typed);
      const cc = parseAll(i.cc, typed);
      const bcc = parseAll(i.bcc, typed);
      await checkRecipients(ctx, before.threadId ?? null, { to, cc, bcc });
      await updateEntity(ctx, i.id, { title: i.subject, body: i.text }, { type: "email_draft" });
      // The Message-ID stays: a Send that went out from this account is still found in Sent.
      const from = i.account ? await accountFor(ctx, i.account) : null;
      await ctx.tx
        .update(mailDraft)
        .set({
          ...(to ? { toAddresses: to } : {}),
          ...(cc ? { ccAddresses: cc } : {}),
          ...(bcc ? { bccAddresses: bcc } : {}),
          ...(from ? { accountId: from.id } : {}),
          version: sql`${mailDraft.version} + 1`,
        })
        .where(eq(mailDraft.entityId, i.id));
      const d = (await loadDraft(ctx.tx, i.id))!;
      // What's in the draft now, for a Send that must match it.
      return { ...d, snapshot: snapshotOf(d) };
    },
  }),
  defineAction({
    name: "mail.drafts",
    description:
      "Drafts waiting to be sent, newest first, or the ones for one conversation, or one by id.",
    input: z.object({ threadId: id.optional(), id: id.optional() }),
    risk: "read",
    // Replies carry the sender's subject and names, and may hold text written after reading mail.
    external: true,
    async handler(i, ctx) {
      const rows = await ctx.tx
        .select({ id: mailDraft.entityId })
        .from(mailDraft)
        .innerJoin(entity, eq(entity.id, mailDraft.entityId))
        .where(
          and(
            isNull(entity.deletedAt),
            i.threadId ? eq(mailDraft.threadId, i.threadId) : undefined,
            i.id ? eq(mailDraft.entityId, i.id) : undefined,
          ),
        )
        .orderBy(desc(entity.updatedAt))
        .limit(100);
      // One after another: a transaction takes one query at a time.
      const out: DraftView[] = [];
      for (const r of rows) {
        const d = await loadDraft(ctx.tx, r.id);
        if (d) out.push(d);
      }
      return out;
    },
  }),
  defineAction({
    name: "mail.discard",
    description: "Throw a draft away, to the trash: entity.restore brings it back.",
    input: z.object({ id }),
    risk: "internal",
    async handler(i, ctx) {
      if (!(await loadDraft(ctx.tx, i.id)))
        throw new ActionError("not_found", "No draft with that id.");
      await trashEntity(ctx, i.id);
      return { discarded: true };
    },
  }),
];

/** A draft as markdown, for Jarvis. */
export async function describeDraft(entityId: string, ctx: ReadContext): Promise<string | null> {
  const d = await loadDraft(ctx.db, entityId);
  if (!d) return null;
  const s = snapshotOf(d);
  return [
    `# ${d.subject || "(no subject)"}`,
    `id: ${d.id} · version ${d.version} · email draft from ${d.account ?? "(no account: the owner picks one before it can go)"}${d.threadId ? ` · a reply in conversation ${d.threadId}` : ""}`,
    `To: ${s.to.join(", ") || "(nobody yet)"}${s.cc.length ? ` · Cc: ${s.cc.join(", ")}` : ""}${s.bcc.length ? ` · Bcc: ${s.bcc.join(", ")}` : ""}`,
    "",
    d.text,
  ].join("\n");
}
