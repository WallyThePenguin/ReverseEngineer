// People from mail, and which lane a sender's mail goes to. Following Macro's rule, someone
// becomes a person when you write to them; mail from people you know is Signal.
import {
  type DbOrTx,
  type MailAddress,
  type MailLane,
  mailMessage,
  mailSenderRule,
  personEmail,
} from "@hearth/db";
import { type ActionContext, addLink, createEntity } from "@hearth/kernel";
import { eq, inArray } from "drizzle-orm";
import { cleanName } from "./mime.ts";

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

export async function personFor(db: DbOrTx, address: string): Promise<string | null> {
  const [row] = await db.select().from(personEmail).where(eq(personEmail.address, address));
  return row?.personId ?? null;
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

// A person you've since put in the trash just isn't linked (addLink checks before writing).
const link = (ctx: ActionContext, fromId: string, toId: string) =>
  addLink(ctx, { fromId, toId, kind: "participant" }).catch(() => {});

/** The person for an address, made from what the mail says about them if they're new. */
export async function ensurePerson(ctx: ActionContext, who: MailAddress): Promise<string> {
  const known = await personFor(ctx.tx, who.address);
  if (known) return known;
  const person = await createEntity(ctx, {
    type: "person",
    // The name is whatever the mail said, so it's kept short and plain.
    title: cleanName(who.name) ?? who.address,
    body: `Email: ${who.address}`,
  });
  await ctx.tx
    .insert(personEmail)
    .values({ address: who.address, personId: person.id })
    .onConflictDoNothing();
  // Mail they sent before you wrote to them is theirs too.
  const earlier = await ctx.tx
    .select({ id: mailMessage.entityId })
    .from(mailMessage)
    .where(eq(mailMessage.fromAddress, who.address))
    .limit(200);
  for (const m of earlier) await link(ctx, m.id, person.id);
  return (await personFor(ctx.tx, who.address)) ?? person.id;
}

/**
 * Links a message to the people on it. Writing to someone makes them a person; mail from someone
 * is linked only if you already know them.
 */
export async function linkPeople(
  ctx: ActionContext,
  messageId: string,
  m: { outbound: boolean; from: MailAddress | null; to: MailAddress[]; cc: MailAddress[] },
  self: string,
): Promise<void> {
  const others = (list: MailAddress[]) => list.filter((a) => a.address !== self);
  if (m.outbound) {
    for (const who of others([...m.to, ...m.cc]).slice(0, 20)) {
      const personId = await ensurePerson(ctx, who);
      await link(ctx, messageId, personId);
    }
    return;
  }
  for (const who of others([...(m.from ? [m.from] : []), ...m.to, ...m.cc]).slice(0, 20)) {
    const personId = await personFor(ctx.tx, who.address);
    if (personId) await link(ctx, messageId, personId);
  }
}
