// Saving mail from a provider: the raw message goes to disk by its hash, the message becomes a
// record, and it joins a conversation by its RFC headers (Message-ID, In-Reply-To, References),
// never by the provider's own thread ids, so every provider threads the same way.
import { entity, type mailAccount, mailMessage, mailThread } from "@hearth/db";
import { type ActionContext, createEntity } from "@hearth/kernel";
import { and, eq, inArray } from "drizzle-orm";
import { BLOB_SERVICE, type BlobStore } from "./blobs.ts";
import { recomputeThread } from "./flags.ts";
import { isCalendar, parseInvite } from "./invites.ts";
import { type ParsedMail, parseMail, snippetOf } from "./mime.ts";
import { laneFor, linkPeople } from "./people.ts";
import type { RawMail } from "./provider.ts";

export type AccountRow = typeof mailAccount.$inferSelect;

/** Drafts are Hearth's own business (M2's drafts), and spam and chats stay out entirely. */
const LEFT_OUT = ["DRAFT", "SPAM", "CHAT"];
/** The most of a message's text kept on its record, for search and for Jarvis. */
const MAX_TEXT = 50_000;

/** The conversation a message belongs to, if Hearth has it already. */
async function findThread(
  ctx: ActionContext,
  accountId: string,
  messageId: string,
  refs: string[],
): Promise<string | null> {
  if (refs.length) {
    const [byMessage] = await ctx.tx
      .select({ threadId: mailMessage.threadId })
      .from(mailMessage)
      .where(and(eq(mailMessage.accountId, accountId), inArray(mailMessage.messageId, refs)))
      .limit(1);
    if (byMessage) return byMessage.threadId;
  }
  // A reply that arrived before the message it answers started the conversation from here.
  const [byRoot] = await ctx.tx
    .select({ id: mailThread.entityId })
    .from(mailThread)
    .where(
      and(
        eq(mailThread.accountId, accountId),
        inArray(mailThread.rootMessageId, [messageId, ...refs]),
      ),
    )
    .limit(1);
  return byRoot?.id ?? null;
}

export interface Saved {
  id: string;
  threadId: string;
  added: boolean;
  outbound: boolean;
  parsed: ParsedMail | null;
}

/** The calendar invitation a message carries, if any. */
function inviteIn(p: ParsedMail) {
  const ics = p.attachments.find(isCalendar);
  return ics ? parseInvite(ics.content.toString("utf8")) : null;
}

/** Saves one message from the provider. Returns null for mail Hearth leaves out. */
export async function saveMail(
  ctx: ActionContext,
  account: AccountRow,
  mail: RawMail,
): Promise<Saved | null> {
  if (mail.labels.some((l) => LEFT_OUT.includes(l))) {
    await removeMail(ctx, account.id, [mail.providerId]);
    return null;
  }
  const [existing] = await ctx.tx
    .select()
    .from(mailMessage)
    .where(and(eq(mailMessage.accountId, account.id), eq(mailMessage.providerId, mail.providerId)));
  if (existing)
    return {
      id: existing.entityId,
      threadId: existing.threadId,
      added: false,
      outbound: existing.outbound,
      parsed: null,
    };

  const rawHash = await ctx.service<BlobStore>(BLOB_SERVICE).put(mail.raw);
  const p = await parseMail(mail.raw);
  const messageId = p.messageId ?? `${mail.providerId}@${account.provider}.hearth`;
  const refs = [...new Set([...p.references, ...(p.inReplyTo ? [p.inReplyTo] : [])])].filter(
    (r) => r !== messageId,
  );
  const outbound = mail.labels.includes("SENT") || p.from?.address === account.address;
  const sentAt = p.date ?? ctx.now;
  const subject = p.subject || "(no subject)";

  let threadId = await findThread(ctx, account.id, messageId, refs);
  if (!threadId) {
    const thread = await createEntity(ctx, { type: "email_thread", title: subject });
    await ctx.tx.insert(mailThread).values({
      entityId: thread.id,
      accountId: account.id,
      rootMessageId: p.references[0] ?? p.inReplyTo ?? messageId,
      lastMessageAt: sentAt,
      lane: await laneFor(ctx.tx, p.from?.address ?? null, mail.labels, outbound),
    });
    threadId = thread.id;
  }
  const message = await createEntity(ctx, {
    type: "email",
    title: subject,
    body: p.text.slice(0, MAX_TEXT),
    parentId: threadId,
  });
  await ctx.tx.insert(mailMessage).values({
    entityId: message.id,
    threadId,
    accountId: account.id,
    providerId: mail.providerId,
    messageId,
    inReplyTo: p.inReplyTo,
    refs: p.references,
    fromAddress: p.from?.address ?? "",
    fromName: p.from?.name ?? null,
    toAddresses: p.to,
    ccAddresses: p.cc,
    replyTo: p.replyTo,
    sentAt,
    labels: mail.labels,
    outbound,
    rawHash,
    hasHtml: p.html !== null,
    attachments: p.attachments.map(({ content: _c, ...a }) => a),
    snippet: snippetOf(p.text),
    invite: inviteIn(p),
  });
  await linkPeople(
    ctx,
    message.id,
    { outbound, from: p.from, to: p.to, cc: p.cc },
    account.address,
  );
  await recomputeThread(ctx, threadId);
  return { id: message.id, threadId, added: true, outbound, parsed: p };
}

/** Removes messages that are gone from the provider, and conversations left empty. */
export async function removeMail(
  ctx: ActionContext,
  accountId: string,
  providerIds: string[],
): Promise<number> {
  if (providerIds.length === 0) return 0;
  const rows = await ctx.tx
    .select({ id: mailMessage.entityId, threadId: mailMessage.threadId })
    .from(mailMessage)
    .where(and(eq(mailMessage.accountId, accountId), inArray(mailMessage.providerId, providerIds)));
  if (rows.length === 0) return 0;
  await ctx.tx.delete(entity).where(
    inArray(
      entity.id,
      rows.map((r) => r.id),
    ),
  );
  for (const t of new Set(rows.map((r) => r.threadId))) await recomputeThread(ctx, t);
  return rows.length;
}
