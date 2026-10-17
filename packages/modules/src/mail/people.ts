// People from mail, and which lane a sender's mail goes to. Following Macro's rule, someone
// becomes a person when you write to them; mail from people you know is Signal.
import { type DbOrTx, type MailAddress, type MailLane, mailSenderRule } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { inArray } from "drizzle-orm";
import { ensurePerson, linkPerson, nameFrom, personFor } from "../people/store.ts";
import { addressKey } from "./mine.ts";

/** Gmail's tabs other than Primary. Mail there starts out as Noise. */
export const NOISE_CATEGORIES = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];

/** "news@mail.shop.example" → the address itself, then "mail.shop.example", then "shop.example". */
export function senderPatterns(address: string): string[] {
  const at = address.lastIndexOf("@");
  if (at < 0) return [address];
  const parts = address.slice(at + 1).split(".");
  const domains = parts.slice(0, -1).map((_, i) => parts.slice(i).join("."));
  return [address, ...domains];
}

/** A rule's pattern from what you typed: an address, a domain, or "@domain". */
export function normalizePattern(raw: string): string | null {
  const p = raw.trim().toLowerCase().replace(/^@/, "");
  if (/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(p)) return p;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(p)) return p;
  return null;
}

/** The lane your rules give an address, most specific rule first. */
export async function ruleFor(db: DbOrTx, address: string): Promise<MailLane | null> {
  const patterns = senderPatterns(address);
  const rules = await db
    .select()
    .from(mailSenderRule)
    .where(inArray(mailSenderRule.pattern, patterns));
  for (const p of patterns) {
    const hit = rules.find((r) => r.pattern === p);
    if (hit) return hit.lane;
  }
  return null;
}

/** Where a new conversation goes: your rules, then people you know, then Gmail's tabs. */
export async function laneFor(
  db: DbOrTx,
  from: string | null,
  labels: string[],
  outbound: boolean,
): Promise<MailLane> {
  if (outbound || !from) return "signal";
  const rule = await ruleFor(db, from);
  if (rule) return rule;
  if (await personFor(db, from)) return "signal";
  return labels.some((l) => NOISE_CATEGORIES.includes(l)) ? "noise" : "signal";
}

/**
 * Links a message to the people on it. Writing to someone makes them a person; mail from someone
 * is linked only if you already know them. You aren't someone you know: none of `mine` (your
 * addresses, by addressKey: your accounts', and for mail you sent, every address you've sent
 * from) becomes a person, or a company for its domain.
 */
export async function linkPeople(
  ctx: ActionContext,
  messageId: string,
  m: { outbound: boolean; from: MailAddress | null; to: MailAddress[]; cc: MailAddress[] },
  mine: ReadonlySet<string>,
): Promise<void> {
  const others = (list: MailAddress[]) => list.filter((a) => !mine.has(addressKey(a.address)));
  if (m.outbound) {
    for (const who of others([...m.to, ...m.cc]).slice(0, 20)) {
      // None for a desk's address, or someone you put in the trash.
      const personId = await ensurePerson(ctx, who);
      if (personId) await linkPerson(ctx, messageId, personId);
    }
    return;
  }
  for (const who of others([...(m.from ? [m.from] : []), ...m.to, ...m.cc]).slice(0, 20)) {
    const personId = await personFor(ctx.tx, who.address);
    if (!personId) continue;
    await linkPerson(ctx, messageId, personId);
    // What they call themselves, for someone known only by their address so far.
    if (who === m.from) await nameFrom(ctx, personId, who);
  }
}
