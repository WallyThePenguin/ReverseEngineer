// Drafts. Anyone may write one (you, or Jarvis drafting a reply); sending one is `mail.send`
// (send.ts), which is outward and waits for your yes.
import { PRINCIPAL } from "@hearth/core";
import {
  type DbOrTx,
  entity,
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
  updateEntity,
} from "@hearth/kernel";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import { body, id } from "../shared.ts";
import { cleanName, newMessageId } from "./mime.ts";
import { checkRecipients } from "./recipients.ts";
import { loadThread } from "./views.ts";

const address = z.string().trim().max(320).describe('An email address, or "Name <address>".');
const addresses = z.array(address).max(50);

/** "Ana Silva <ana@x.example>" or "ana@x.example" → an address, or null if it isn't one. */
export function parseAddress(raw: string): MailAddress | null {
  const m =
    raw.trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/) ??
    raw.trim().match(/^()([^<>\s]+@[^<>\s]+)$/);
  if (!m || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m[2]!)) return null;
  return clean({ address: m[2]!, name: m[1] });
}

/** An address as a draft keeps it: lower-case, with a name that's safe to show. */
function clean(a: MailAddress): MailAddress {
  const name = cleanName(a.name);
  return { address: a.address.toLowerCase(), ...(name ? { name } : {}) };
}

/** Address first, so a name can't pass for another recipient: "ana@x.example (Ana Silva)". */
const shown = (a: MailAddress) => (a.name ? `${a.address} (${a.name})` : a.address);
/** Subjects on one line, without characters that change how the line reads. */
export const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ");

function parseAll(list: string[] | undefined): MailAddress[] | undefined {
  if (!list) return undefined;
  return list.map((raw) => {
    const a = parseAddress(raw);
    if (!a) throw new ActionError("invalid_input", `"${raw}" isn't an email address.`);
    return a;
  });
}

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
  if (!row)
    throw new ActionError(
      wanted ? "not_found" : "unavailable",
      wanted
        ? `No mail account ${wanted} is connected.`
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
    .orderBy(desc(mailMessage.sentAt));
  const last = rows.find((m) => !m.outbound) ?? rows[0];
  if (!last) throw new ActionError("not_found", "That conversation has no messages.");
  const [account] = await ctx.tx
    .select()
    .from(mailAccount)
    .where(eq(mailAccount.id, last.accountId));
  const self = account!.address;
  const from: MailAddress = {
    address: last.fromAddress,
    ...(last.fromName ? { name: last.fromName } : {}),
  };
  const to = (
    last.outbound ? last.toAddresses : [last.replyTo ? { address: last.replyTo } : from]
  ).map(clean);
  const taken = new Set([self, ...to.map((a) => a.address)]);
  const cc = all
    ? [...last.toAddresses, ...last.ccAddresses].map(clean).filter((a) => {
        if (taken.has(a.address)) return false;
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
      subject: z.string().max(500).optional(),
      text: body,
      account: z.string().email().optional().describe("Which of the owner's accounts it's from."),
    }),
    risk: "internal",
    async handler(i, ctx) {
      if (i.threadId && ctx.caller.principal === PRINCIPAL.jarvis)
        await oneDraftEach(ctx, i.threadId);
      const asked = { to: parseAll(i.to), cc: parseAll(i.cc), bcc: parseAll(i.bcc) };
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
      "Change a draft: recipients, subject, text, or the account it goes from. Leave out what stays the same.",
    input: z.object({
      id,
      to: addresses.optional(),
      cc: addresses.optional(),
      bcc: addresses.optional(),
      subject: z.string().max(500).optional(),
      text: body.optional(),
      account: z.string().email().optional().describe("Which of the owner's accounts it's from."),
    }),
    risk: "internal",
    async handler(i, ctx) {
      const before = await loadDraft(ctx.tx, i.id);
      if (!before) throw new ActionError("not_found", "No draft with that id.");
      const to = parseAll(i.to);
      const cc = parseAll(i.cc);
      const bcc = parseAll(i.bcc);
      await checkRecipients(ctx, before.threadId ?? null, { to, cc, bcc });
      await updateEntity(ctx, i.id, { title: i.subject, body: i.text }, { type: "email_draft" });
      // The Message-ID stays: a Send that went out from this account is still found in Sent.
      const from = i.account ? await accountFor(ctx, i.account) : null;
      if (to || cc || bcc || from)
        await ctx.tx
          .update(mailDraft)
          .set({
            ...(to ? { toAddresses: to } : {}),
            ...(cc ? { ccAddresses: cc } : {}),
            ...(bcc ? { bccAddresses: bcc } : {}),
            ...(from ? { accountId: from.id } : {}),
          })
          .where(eq(mailDraft.entityId, i.id));
      const d = (await loadDraft(ctx.tx, i.id))!;
      // What's in the draft now, for a Send that must match it.
      return { ...d, snapshot: snapshotOf(d) };
    },
  }),
  defineAction({
    name: "mail.drafts",
    description: "Drafts waiting to be sent, newest first, or the ones for one conversation.",
    input: z.object({ threadId: id.optional() }),
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
    description: "Throw a draft away.",
    input: z.object({ id }),
    risk: "internal",
    async handler(i, ctx) {
      if (!(await loadDraft(ctx.tx, i.id)))
        throw new ActionError("not_found", "No draft with that id.");
      await ctx.tx.delete(entity).where(eq(entity.id, i.id));
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
    `id: ${d.id} · email draft from ${d.account ?? "(no account: the owner picks one before it can go)"}${d.threadId ? ` · a reply in conversation ${d.threadId}` : ""}`,
    `To: ${s.to.join(", ") || "(nobody yet)"}${s.cc.length ? ` · Cc: ${s.cc.join(", ")}` : ""}${s.bcc.length ? ` · Bcc: ${s.bcc.join(", ")}` : ""}`,
    "",
    d.text,
  ].join("\n");
}
