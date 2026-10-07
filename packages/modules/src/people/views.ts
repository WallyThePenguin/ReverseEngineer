// What the person and company pages show, and what Jarvis reads about someone: their addresses,
// company, when you last talked, and everything linked to them.
import {
  calendarEvent,
  company,
  type DbOrTx,
  entity,
  link,
  mailMessage,
  person,
  personEmail,
} from "@hearth/db";
import type { EntityRow } from "@hearth/kernel";
import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  max,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import { type LastContact, lastContacts } from "./store.ts";

const DAY_MS = 24 * 3600_000;

export interface Linked {
  id: string;
  type: string;
  title: string;
  at: Date;
}

export interface PersonView {
  id: string;
  name: string;
  notes: string;
  createdBy: string;
  emails: string[];
  company: { id: string; name: string; domain: string } | null;
  followUpDays: number | null;
  /** Days since you last talked, when that's past the follow-up. */
  overdueDays: number | null;
  fields: Record<string, string>;
  lastContact: LastContact | null;
  threads: (Linked & { messages: number })[];
  upcoming: Linked[];
  met: Linked[];
  items: Linked[];
}

/** Days since you last talked (or added them), if it's at least their follow-up. */
export function overdue(
  days: number | null,
  last: LastContact | undefined,
  createdAt: Date,
  now: Date,
): number | null {
  if (!days) return null;
  const since = Math.floor((now.getTime() - (last?.at ?? createdAt).getTime()) / DAY_MS);
  return since >= days ? since : null;
}

async function emailsOf(db: DbOrTx, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(personEmail)
    .where(inArray(personEmail.personId, ids))
    .orderBy(asc(personEmail.address));
}

export async function personView(db: DbOrTx, e: EntityRow, now: Date): Promise<PersonView> {
  const id = e.id;
  const [profile] = await db
    .select({ p: person, name: entity.title, domain: company.domain })
    .from(person)
    .leftJoin(entity, and(eq(entity.id, person.companyId), isNull(entity.deletedAt)))
    .leftJoin(company, eq(company.entityId, person.companyId))
    .where(eq(person.entityId, id));
  const last = (await lastContacts(db, [id], now)).get(id) ?? null;
  const threads = await db
    .select({
      id: mailMessage.threadId,
      at: max(mailMessage.sentAt),
      // An email in two of your accounts is one message.
      messages: countDistinct(mailMessage.messageId),
    })
    .from(link)
    .innerJoin(mailMessage, eq(mailMessage.entityId, link.fromId))
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(and(eq(link.toId, id), eq(link.kind, "participant"), isNull(entity.deletedAt)))
    .groupBy(mailMessage.threadId)
    .orderBy(desc(max(mailMessage.sentAt)))
    .limit(15);
  const titles = threads.length
    ? await db
        .select({ id: entity.id, title: entity.title })
        .from(entity)
        .where(
          and(
            inArray(
              entity.id,
              threads.map((t) => t.id),
            ),
            isNull(entity.deletedAt),
          ),
        )
    : [];
  const events = (when: "upcoming" | "met") =>
    db
      .select({ id: entity.id, title: entity.title, at: calendarEvent.startsAt })
      .from(link)
      .innerJoin(calendarEvent, eq(calendarEvent.entityId, link.fromId))
      .innerJoin(entity, eq(entity.id, link.fromId))
      .where(
        and(
          eq(link.toId, id),
          isNull(entity.deletedAt),
          ne(calendarEvent.status, "cancelled"),
          when === "upcoming" ? gt(calendarEvent.startsAt, now) : lte(calendarEvent.startsAt, now),
        ),
      )
      .orderBy(when === "upcoming" ? asc(calendarEvent.startsAt) : desc(calendarEvent.startsAt))
      .limit(when === "upcoming" ? 5 : 10);
  // Tasks, notes, meetings and the rest, linked either way.
  const other = await db
    .select({ id: entity.id, type: entity.type, title: entity.title, at: entity.updatedAt })
    .from(link)
    .innerJoin(entity, or(eq(entity.id, link.fromId), eq(entity.id, link.toId)))
    .where(
      and(
        or(eq(link.toId, id), eq(link.fromId, id)),
        ne(entity.id, id),
        isNull(entity.deletedAt),
        notInArray(entity.type, ["email", "email_thread", "event", "comment"]),
      ),
    )
    .orderBy(desc(entity.updatedAt))
    .limit(30);
  const seen = new Set<string>();
  return {
    id,
    name: e.title,
    notes: e.body ?? "",
    createdBy: e.createdBy,
    emails: (await emailsOf(db, [id])).map((x) => x.address),
    company:
      profile?.p.companyId && profile.name !== null
        ? { id: profile.p.companyId, name: profile.name, domain: profile.domain ?? "" }
        : null,
    followUpDays: profile?.p.followUpDays ?? null,
    overdueDays: overdue(profile?.p.followUpDays ?? null, last ?? undefined, e.createdAt, now),
    fields: profile?.p.fields ?? {},
    lastContact: last,
    threads: threads.flatMap((t) => {
      const title = titles.find((x) => x.id === t.id)?.title;
      return title === undefined || !t.at
        ? []
        : [{ id: t.id, type: "email_thread", title, at: t.at, messages: t.messages }];
    }),
    upcoming: (await events("upcoming")).map((x) => ({ ...x, type: "event" })),
    met: (await events("met")).map((x) => ({ ...x, type: "event" })),
    items: other.filter((x) => !seen.has(x.id) && seen.add(x.id)),
  };
}

export interface PersonSummary {
  id: string;
  name: string;
  company: string | null;
  lastContact: LastContact | null;
  followUpDays: number | null;
  overdueDays: number | null;
}

/** People, by name, with their company and when you last talked. */
export async function listPeople(
  db: DbOrTx,
  now: Date,
  opts: { companyId?: string; limit: number },
): Promise<PersonSummary[]> {
  const co = db
    .select({ id: entity.id, title: entity.title })
    .from(entity)
    .where(and(eq(entity.type, "company"), isNull(entity.deletedAt)))
    .as("co");
  const rows = await db
    .select({ e: entity, p: person, company: co.title })
    .from(entity)
    .leftJoin(person, eq(person.entityId, entity.id))
    .leftJoin(co, eq(co.id, person.companyId))
    .where(
      and(
        eq(entity.type, "person"),
        isNull(entity.deletedAt),
        ...(opts.companyId ? [eq(person.companyId, opts.companyId)] : []),
      ),
    )
    .orderBy(asc(entity.title))
    .limit(opts.limit);
  const last = await lastContacts(
    db,
    rows.map((r) => r.e.id),
    now,
  );
  return rows.map((r) => {
    const l = last.get(r.e.id);
    const days = r.p?.followUpDays ?? null;
    return {
      id: r.e.id,
      name: r.e.title,
      company: r.company,
      lastContact: l ?? null,
      followUpDays: days,
      overdueDays: overdue(days, l, r.e.createdAt, now),
    };
  });
}

/** What Jarvis reads under a person's notes. */
export function personFacts(v: PersonView, fmt: (d: Date) => string): string {
  const lines: string[] = [];
  if (v.emails.length) lines.push(`Email: ${v.emails.join(", ")}`);
  if (v.company)
    lines.push(`Company: ${v.company.name} (${v.company.domain}, company ${v.company.id})`);
  for (const [k, val] of Object.entries(v.fields)) lines.push(`${k}: ${val}`);
  lines.push(
    v.lastContact
      ? `Last talked: ${fmt(v.lastContact.at)} (${v.lastContact.kind})`
      : "Last talked: nothing on record",
  );
  if (v.followUpDays)
    lines.push(
      `Keep in touch every ${v.followUpDays} days${v.overdueDays ? ` (overdue: ${v.overdueDays} days)` : ""}`,
    );
  for (const x of v.upcoming) lines.push(`Upcoming: "${x.title}" ${fmt(x.at)} (event ${x.id})`);
  for (const x of v.met.slice(0, 5)) lines.push(`Met: "${x.title}" ${fmt(x.at)} (event ${x.id})`);
  for (const x of v.threads.slice(0, 8))
    lines.push(`Email: "${x.title}" ${fmt(x.at)} (thread ${x.id})`);
  for (const x of v.items.slice(0, 15)) lines.push(`Linked ${x.type}: "${x.title}" (${x.id})`);
  return lines.join("\n");
}
