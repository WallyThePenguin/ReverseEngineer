// Your own addresses (6.9). Gmail delivers mail for every spelling of your address (any case,
// any dots, any +tag) and for the addresses you send as, so mail to any of those is to you: the
// accounts you've connected, and every address your Sent mail went from (Gmail's "Send mail as"
// aliases, as you use them; Hearth doesn't ask Google for the list).
import { type DbOrTx, mailAccount, mailMessage } from "@hearth/db";
import { and, arrayContains, eq } from "drizzle-orm";

/** Domains where dots in the name don't matter: Gmail's own. */
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** An address as Gmail tells yours apart: no case, no +tag, and for Gmail's own, no dots. */
export function addressKey(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0) return a;
  const domain = a.slice(at + 1);
  let name = a.slice(0, at).split("+")[0] || a.slice(0, at);
  if (!GMAIL.has(domain)) return `${name}@${domain}`;
  name = name.replaceAll(".", "");
  return `${name}@gmail.com`;
}

/** Whether any of `addresses` is one of `mine` (keys from addressKey). */
export const toAnyOf = (addresses: readonly { address: string }[], mine: ReadonlySet<string>) =>
  addresses.some((a) => mine.has(addressKey(a.address)));

/** All your addresses, by addressKey: every connected account's, and every one you've sent from. */
export async function yourAddresses(db: DbOrTx): Promise<Set<string>> {
  const accounts = await db.select({ address: mailAccount.address }).from(mailAccount);
  const sentFrom = await db
    .selectDistinct({ address: mailMessage.fromAddress })
    .from(mailMessage)
    .where(and(eq(mailMessage.outbound, true), arrayContains(mailMessage.labels, ["SENT"])));
  return new Set(
    [...accounts, ...sentFrom].filter((r) => r.address).map((r) => addressKey(r.address)),
  );
}
