// Who a draft by anyone but you may go to. Jarvis (or an outside agent) never adds a Bcc, a reply
// goes only to people already on the conversation, and a turn that read outside content can't
// address a new email at all: otherwise one email could get a copy of your mail sent elsewhere
// in a draft you'd send without looking twice. Enforced here, not left to the prompt.
import { type DbOrTx, type MailAddress, mailAccount, mailMessage } from "@hearth/db";
import { type ActionContext, ActionError } from "@hearth/kernel";
import { asc, eq } from "drizzle-orm";
import { once } from "./copies.ts";

/**
 * Everyone on a conversation as it shows (a copy of an email in another account that isn't
 * shown adds no one), and your own addresses, lowercased.
 */
async function onConversation(db: DbOrTx, threadId: string): Promise<Set<string>> {
  const found = await db
    .select({
      accountId: mailMessage.accountId,
      copyKey: mailMessage.copyKey,
      outbound: mailMessage.outbound,
      labels: mailMessage.labels,
      from: mailMessage.fromAddress,
      replyTo: mailMessage.replyTo,
      to: mailMessage.toAddresses,
      cc: mailMessage.ccAddresses,
    })
    .from(mailMessage)
    .where(eq(mailMessage.threadId, threadId))
    .orderBy(asc(mailMessage.sentAt), asc(mailMessage.entityId));
  const rows = once(found);
  const mine = await db.select({ address: mailAccount.address }).from(mailAccount);
  const all = [
    ...rows.flatMap((r) => [r.from, r.replyTo ?? "", ...r.to.map((a) => a.address)]),
    ...rows.flatMap((r) => r.cc.map((a) => a.address)),
    ...mine.map((m) => m.address),
  ];
  return new Set(all.filter(Boolean).map((a) => a.toLowerCase()));
}

/**
 * Refuses recipients a draft written by anyone but the owner mustn't have. `threadId` is the
 * conversation the draft answers, if any.
 */
export async function checkRecipients(
  ctx: Pick<ActionContext, "tx" | "caller">,
  threadId: string | null,
  r: { to?: MailAddress[]; cc?: MailAddress[]; bcc?: MailAddress[] },
): Promise<void> {
  if (ctx.caller.kind === "owner") return;
  if (r.bcc?.length)
    throw new ActionError(
      "forbidden",
      "Only the owner adds a Bcc. Leave bcc out; if someone should get a copy, say so to the owner.",
    );
  const asked = [...(r.to ?? []), ...(r.cc ?? [])];
  if (!asked.length) return;
  if (!threadId) {
    if (ctx.caller.origin !== "untrusted") return;
    throw new ActionError(
      "forbidden",
      "After reading outside content, a new email can't be addressed: only the owner chooses who it goes to.",
    );
  }
  const known = await onConversation(ctx.tx, threadId);
  const strangers = asked.filter((a) => !known.has(a.address.toLowerCase()));
  if (strangers.length)
    throw new ActionError(
      "forbidden",
      `${strangers.map((a) => a.address).join(", ")} ${strangers.length === 1 ? "isn't" : "aren't"} on this conversation, and only the owner adds people. Leave to and cc out to answer the conversation.`,
    );
}
