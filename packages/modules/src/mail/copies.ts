// The same email sent to two of your accounts is one message in Hearth. Each account keeps its own
// copy, so archiving or reading it reaches both Gmails, but it shows once and its conversation gets
// one reply. Only the identical email is a copy: anyone who got it knows its Message-ID and can
// send a new one reusing it, so copies share a fingerprint of everything the email says (copyKey).
// A copy that isn't shown has no say: what's shown, replied to and waited on is the one kept.
import { createHash } from "node:crypto";
import { mailAccount, mailMessage } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import type { ParsedMail } from "./mime.ts";

/**
 * An email's fingerprint: its Message-ID, From, To, Cc, Reply-To, Subject, Date as sent (to the
 * millisecond, or none), body and attachments. A copy delivered to another account has the same;
 * a forgery that matched it all would have nothing left to change.
 */
export function copyKey(p: ParsedMail, messageId: string): string {
  const addresses = (xs: readonly { address: string }[]) => xs.map((a) => a.address.toLowerCase());
  const files = p.attachments.map((a) => createHash("sha256").update(a.content).digest("hex"));
  return createHash("sha256")
    .update(
      JSON.stringify([
        messageId,
        p.from?.address.toLowerCase() ?? null,
        addresses(p.to),
        addresses(p.cc),
        p.replyTo?.toLowerCase() ?? null,
        p.subject,
        p.date?.getTime() ?? null,
        p.text,
        p.html,
        files,
      ]),
    )
    .digest("base64url");
}

/** Your accounts but this one. */
export const otherAccounts = (ctx: Pick<ActionContext, "tx">, accountId: string) =>
  ctx.tx.select({ id: mailAccount.id }).from(mailAccount).where(ne(mailAccount.id, accountId));

/** The conversation that holds this email's copy in another of your accounts, if it has one. */
export async function copyThread(
  ctx: ActionContext,
  accountId: string,
  messageId: string,
  key: string,
): Promise<string | null> {
  const others = otherAccounts(ctx, accountId);
  const [copy] = await ctx.tx
    .select({ threadId: mailMessage.threadId })
    .from(mailMessage)
    .where(
      and(
        inArray(mailMessage.accountId, others),
        eq(mailMessage.messageId, messageId),
        eq(mailMessage.copyKey, key),
      ),
    )
    .orderBy(asc(mailMessage.entityId))
    .limit(1);
  return copy?.threadId ?? null;
}

export interface Copyable {
  accountId: string;
  copyKey: string | null;
  outbound: boolean;
  labels: string[];
}

/** The flags a copy that isn't shown adds to the one that is: unread or starred in either. */
const POOLED = new Set(["UNREAD", "STARRED"]);
const pooled = (labels: readonly string[]) => labels.filter((l) => POOLED.has(l));

/**
 * Each email once. Of its copies, the one shown is the first saved, or the one you sent if a copy
 * is (your email cc'd to another of yours is yours, not mail to you). It's unread or starred if
 * any copy is; everything else about it (its Gmail tab, importance) is its own. `rows` come in
 * order of sentAt, then entityId (which is in the order saved).
 */
export function once<T extends Copyable>(rows: readonly T[]): T[] {
  const seen = new Map<string, { kept: T; accounts: Set<string> }[]>();
  const out: T[] = [];
  for (const m of rows) {
    const same = m.copyKey ? (seen.get(m.copyKey) ?? []) : [];
    const of = same.find((s) => !s.accounts.has(m.accountId));
    if (!of) {
      const kept = { ...m };
      if (m.copyKey) seen.set(m.copyKey, [...same, { kept, accounts: new Set([m.accountId]) }]);
      out.push(kept);
      continue;
    }
    of.accounts.add(m.accountId);
    const flags = (labels: string[], other: string[]) => [
      ...new Set([...labels, ...pooled(other)]),
    ];
    if (m.outbound && !of.kept.outbound)
      Object.assign(of.kept, m, { labels: flags(m.labels, of.kept.labels) });
    else of.kept.labels = flags(of.kept.labels, m.labels);
  }
  return out;
}
