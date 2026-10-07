// The same email sent to two of your accounts is one message in Hearth. Each account keeps its own
// copy, so archiving or reading it reaches both Gmails, but it shows once and its conversation gets
// one reply. A Message-ID alone isn't proof: anyone who got the email knows it and can send a new
// one reusing it. So copies also share their sender, subject and date (to the second), and are in
// different accounts; within one account, Gmail itself keeps one of each.
import { entity, mailAccount, mailMessage } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, asc, eq, inArray, ne } from "drizzle-orm";

interface Email {
  messageId: string;
  fromAddress: string;
  sentAt: Date;
  subject: string;
}

export interface Copyable extends Email {
  accountId: string;
  labels: string[];
}

const keyOf = (m: Email) =>
  [m.messageId, m.fromAddress.toLowerCase(), Math.floor(m.sentAt.getTime() / 1000), m.subject].join(
    "\n",
  );

/** The conversation that holds this email's copy in another of your accounts, if it has one. */
export async function copyThread(
  ctx: ActionContext,
  accountId: string,
  m: Email,
): Promise<string | null> {
  const others = ctx.tx
    .select({ id: mailAccount.id })
    .from(mailAccount)
    .where(ne(mailAccount.id, accountId));
  const rows = await ctx.tx
    .select({
      threadId: mailMessage.threadId,
      messageId: mailMessage.messageId,
      fromAddress: mailMessage.fromAddress,
      sentAt: mailMessage.sentAt,
      subject: entity.title,
    })
    .from(mailMessage)
    .innerJoin(entity, eq(entity.id, mailMessage.entityId))
    .where(and(inArray(mailMessage.accountId, others), eq(mailMessage.messageId, m.messageId)))
    .orderBy(asc(mailMessage.entityId));
  const key = keyOf(m);
  return rows.find((r) => keyOf(r) === key)?.threadId ?? null;
}

/**
 * Each email once: a copy in another account is left out, and its flags join the one kept, the
 * first saved. `rows` come in order of sentAt, then entityId (which is in the order saved).
 */
export function once<T extends Copyable>(rows: readonly T[]): T[] {
  const seen = new Map<string, { kept: T; accounts: Set<string> }[]>();
  const out: T[] = [];
  for (const m of rows) {
    const key = keyOf(m);
    const same = seen.get(key) ?? [];
    const of = same.find((s) => !s.accounts.has(m.accountId));
    if (of) {
      of.accounts.add(m.accountId);
      of.kept.labels = [...new Set([...of.kept.labels, ...m.labels])];
      continue;
    }
    const kept = { ...m };
    same.push({ kept, accounts: new Set([m.accountId]) });
    seen.set(key, same);
    out.push(kept);
  }
  return out;
}
