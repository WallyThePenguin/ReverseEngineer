// People and companies as Hearth keeps them: a person entity, the addresses that are theirs, a
// profile row (company, follow-up, your fields), and the company their mail domain stands for.
import {
  calendarEvent,
  company,
  type DbOrTx,
  entity,
  googleAccount,
  link,
  type MailAddress,
  mailMessage,
  person,
  personEmail,
} from "@hearth/db";
import { type ActionContext, addLink, createEntity, updateEntity } from "@hearth/kernel";
import { and, asc, eq, inArray, isNotNull, isNull, lte, max, ne, or, sql } from "drizzle-orm";
import { cleanName } from "../mail/mime.ts";
import { accountAddresses, addressKey } from "../mail/mine.ts";
import { companyDomain, companyName, isRoleAddress } from "./domains.ts";

/** Whose an address is, in the trash or not: an address is one person's, so no one else's. */
async function holderOf(db: DbOrTx, address: string) {
  const [row] = await db
    .select({ id: personEmail.personId, title: entity.title, gone: entity.deletedAt })
    .from(personEmail)
    .innerJoin(entity, eq(entity.id, personEmail.personId))
    .where(eq(personEmail.address, address));
  return row ?? null;
}

/** The person an address is: one you put in the trash isn't someone you know. */
export async function personFor(db: DbOrTx, address: string): Promise<string | null> {
  const holder = await holderOf(db, address);
  return holder && !holder.gone ? holder.id : null;
}

/** Your connected accounts' addresses, Gmail's and Calendar's, by addressKey: none is a person. */
export async function yourAccounts(db: DbOrTx): Promise<Set<string>> {
  const mine = await accountAddresses(db);
  const google = await db.select({ email: googleAccount.email }).from(googleAccount);
  for (const g of google) mine.add(addressKey(g.email));
  return mine;
}

/** The person in the trash an address is, if it's one: it can't be given to anyone else. */
export async function trashedFor(db: DbOrTx, address: string): Promise<string | null> {
  const holder = await holderOf(db, address);
  return holder?.gone ? holder.id : null;
}

/**
 * A person still named by their address takes the name a later mail or invitation gives them.
 * A name you gave them, or the one they first came with, stays.
 */
export async function nameFrom(ctx: ActionContext, personId: string, who: MailAddress) {
  const name = cleanName(who.name);
  if (!name) return;
  const [row] = await ctx.tx
    .select({ title: entity.title })
    .from(entity)
    .where(and(eq(entity.id, personId), isNull(entity.deletedAt)));
  if (row?.title.toLowerCase() === who.address.toLowerCase())
    await updateEntity(ctx, personId, { title: name }, { type: "person" });
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

/**
 * The person for an address, made from what the mail or invitation says about them if new. None
 * for a desk's address (support@, noreply@…), which isn't a person, or for a person you put in
 * the trash: Hearth leaves them there.
 */
export async function ensurePerson(ctx: ActionContext, who: MailAddress): Promise<string | null> {
  const holder = await holderOf(ctx.tx, who.address);
  if (holder?.gone) return null;
  if (holder) {
    await nameFrom(ctx, holder.id, who);
    return holder.id;
  }
  if (isRoleAddress(who.address)) return null;
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

/**
 * When you last emailed or met each person, up to now: mail you sent them or they sent, and
 * meetings you organized or accepted. Spam doesn't count.
 */
export async function lastContacts(
  db: DbOrTx,
  ids: string[],
  now: Date,
): Promise<Map<string, LastContact>> {
  const out = new Map<string, LastContact>();
  if (ids.length === 0) return out;
  // Mail you sent them, or mail from them; a stranger copying them in doesn't count.
  const mail = await db
    .select({ id: link.toId, at: max(mailMessage.sentAt) })
    .from(link)
    .innerJoin(mailMessage, eq(mailMessage.entityId, link.fromId))
    .innerJoin(entity, eq(entity.id, link.fromId))
    .leftJoin(
      personEmail,
      and(eq(personEmail.address, mailMessage.fromAddress), eq(personEmail.personId, link.toId)),
    )
    .where(
      and(
        inArray(link.toId, ids),
        eq(link.kind, "participant"),
        isNull(entity.deletedAt),
        lte(mailMessage.sentAt, now),
        sql`NOT ('SPAM' = ANY(${mailMessage.labels}))`,
        or(
          and(eq(mailMessage.outbound, true), sql`'SENT' = ANY(${mailMessage.labels})`),
          isNotNull(personEmail.address),
        ),
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
        // Meetings you set up or said yes to; an invitation you never answered doesn't count.
        or(eq(calendarEvent.selfOrganizer, true), eq(calendarEvent.selfResponse, "accepted")),
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
