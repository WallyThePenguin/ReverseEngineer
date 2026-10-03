// People and companies as Hearth keeps them: a person entity, the addresses that are theirs, a
// profile row (company, follow-up, your fields), and the company their mail domain stands for.
import {
  calendarEvent,
  company,
  type DbOrTx,
  entity,
  link,
  type MailAddress,
  mailMessage,
  person,
  personEmail,
} from "@hearth/db";
import { type ActionContext, addLink, createEntity } from "@hearth/kernel";
import { and, asc, eq, inArray, isNull, lte, max, ne, or, sql } from "drizzle-orm";
import { cleanName } from "../mail/mime.ts";
import { companyDomain, companyName } from "./domains.ts";

export async function personFor(db: DbOrTx, address: string): Promise<string | null> {
  const [row] = await db.select().from(personEmail).where(eq(personEmail.address, address));
  return row?.personId ?? null;
}

/** The company for a domain, made the first time someone there becomes a person. */
export async function ensureCompany(ctx: ActionContext, domain: string): Promise<string> {
  const [known] = await ctx.tx.select().from(company).where(eq(company.domain, domain));
  if (known) return known.entityId;
  const row = await createEntity(ctx, { type: "company", title: companyName(domain), body: "" });
  await ctx.tx.insert(company).values({ entityId: row.id, domain }).onConflictDoNothing();
  const [saved] = await ctx.tx.select().from(company).where(eq(company.domain, domain));
  return saved!.entityId;
}

/** A person's profile row, with the company of their first work address. */
export async function ensureProfile(ctx: ActionContext, personId: string): Promise<void> {
  const [has] = await ctx.tx.select().from(person).where(eq(person.entityId, personId));
  if (has) return;
  const emails = await ctx.tx
    .select({ address: personEmail.address })
    .from(personEmail)
    .where(eq(personEmail.personId, personId))
    .orderBy(asc(personEmail.address));
  const domain = emails.map((e) => companyDomain(e.address)).find(Boolean) ?? null;
  const companyId = domain ? await ensureCompany(ctx, domain) : null;
  await ctx.tx.insert(person).values({ entityId: personId, companyId }).onConflictDoNothing();
}

// A person you've since put in the trash just isn't linked (addLink checks before writing).
export const linkPerson = (ctx: ActionContext, fromId: string, toId: string) =>
  addLink(ctx, { fromId, toId, kind: "participant" }).catch(() => {});

/** The person for an address, made from what the mail or invitation says about them if new. */
export async function ensurePerson(ctx: ActionContext, who: MailAddress): Promise<string> {
  const known = await personFor(ctx.tx, who.address);
  if (known) return known;
  const created = await createEntity(ctx, {
    type: "person",
    // The name is whatever the mail said, so it's kept short and plain.
    title: cleanName(who.name) ?? who.address,
    body: `Email: ${who.address}`,
  });
  await ctx.tx
    .insert(personEmail)
    .values({ address: who.address, personId: created.id })
    .onConflictDoNothing();
  const id = (await personFor(ctx.tx, who.address)) ?? created.id;
  if (id !== created.id) return id;
  await ensureProfile(ctx, id);
  // Mail they sent before you wrote to them is theirs too.
  const earlier = await ctx.tx
    .select({ id: mailMessage.entityId })
    .from(mailMessage)
    .where(eq(mailMessage.fromAddress, who.address))
    .limit(200);
  for (const m of earlier) await linkPerson(ctx, m.id, id);
  return id;
}

export interface LastContact {
  at: Date;
  kind: "email" | "meeting";
}

/** When you last emailed or met each person, up to now. Spam and declined meetings don't count. */
export async function lastContacts(
  db: DbOrTx,
  ids: string[],
  now: Date,
): Promise<Map<string, LastContact>> {
  const out = new Map<string, LastContact>();
  if (ids.length === 0) return out;
  const mail = await db
    .select({ id: link.toId, at: max(mailMessage.sentAt) })
    .from(link)
    .innerJoin(mailMessage, eq(mailMessage.entityId, link.fromId))
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(
      and(
        inArray(link.toId, ids),
        eq(link.kind, "participant"),
        isNull(entity.deletedAt),
        lte(mailMessage.sentAt, now),
        sql`NOT ('SPAM' = ANY(${mailMessage.labels}))`,
      ),
    )
    .groupBy(link.toId);
  const met = await db
    .select({ id: link.toId, at: max(calendarEvent.startsAt) })
    .from(link)
    .innerJoin(calendarEvent, eq(calendarEvent.entityId, link.fromId))
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(
      and(
        inArray(link.toId, ids),
        eq(link.kind, "participant"),
        isNull(entity.deletedAt),
        lte(calendarEvent.startsAt, now),
        ne(calendarEvent.status, "cancelled"),
        or(isNull(calendarEvent.selfResponse), ne(calendarEvent.selfResponse, "declined")),
      ),
    )
    .groupBy(link.toId);
  for (const r of mail) if (r.at) out.set(r.id, { at: r.at, kind: "email" });
  for (const r of met) {
    const prev = out.get(r.id);
    if (r.at && (!prev || r.at > prev.at)) out.set(r.id, { at: r.at, kind: "meeting" });
  }
  return out;
}
