// People and companies: a personal CRM built from your mail and calendar (PLAN.md section 8.7).
// Writing to someone or meeting them makes them a person; their work domain makes a company.
// Each person page shows every linked thread, meeting, task and note, when you last talked, and
// a follow-up reminder ("you haven't talked to X in 60 days") when you want one.
import { formatDateTime } from "@hearth/core";
import { company, entity, person, personEmail } from "@hearth/db";
import {
  ActionError,
  createEntity,
  type DigestItem,
  defineAction,
  defineModule,
  getSetting,
  updateEntity,
} from "@hearth/kernel";
import { and, asc, count, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { body, describeRow, id, isOutside, liveEntity } from "../shared.ts";
import { companyDomain } from "./domains.ts";
import { ensureCompany, ensureProfile, lastContacts, personFor } from "./store.ts";
import { listPeople, overdue, personFacts, personView } from "./views.ts";

const name = z.string().trim().min(1).max(200);
const email = z.string().trim().toLowerCase().email().max(320);
const fields = z
  .record(z.string().trim().min(1).max(60), z.string().max(2000))
  .refine((f) => Object.keys(f).length <= 30, "At most 30 fields");

async function livePerson(ctx: { tx: Parameters<typeof liveEntity>[0] }, personId: string) {
  const row = await liveEntity(ctx.tx, personId, "person");
  if (!row) throw new ActionError("not_found", "No such person");
  return row;
}

async function addEmail(
  ctx: Parameters<typeof ensureProfile>[0],
  personId: string,
  address: string,
) {
  const owner = await personFor(ctx.tx, address);
  if (owner && owner !== personId)
    throw new ActionError("conflict", `${address} already belongs to another person (${owner})`);
  await ctx.tx.insert(personEmail).values({ address, personId }).onConflictDoNothing();
}

const personActions = [
  defineAction({
    name: "person.create",
    description:
      "Add a person. Put how you know them in the notes; add their address with person_add_email.",
    input: z.object({ name, notes: body.optional() }),
    risk: "internal",
    async handler(i, ctx) {
      const row = await createEntity(ctx, { type: "person", title: i.name, body: i.notes ?? "" });
      await ensureProfile(ctx, row.id);
      return row;
    },
  }),
  defineAction({
    name: "person.add_email",
    description: "Record another email address as this person's.",
    input: z.object({ id, email }),
    // Whose an address is decides which lane their mail lands in and who mail to "them" goes
    // to, so a turn that read outside content asks first.
    risk: "self_external",
    summarize: (i) => `Record ${i.email} as this person's email address`,
    async handler(i, ctx) {
      const row = await livePerson(ctx, i.id);
      await addEmail(ctx, i.id, i.email);
      await ensureProfile(ctx, i.id);
      // Someone you added by name gets a company from their first work address.
      const domain = companyDomain(i.email);
      if (domain)
        await ctx.tx
          .update(person)
          .set({ companyId: await ensureCompany(ctx, domain) })
          .where(and(eq(person.entityId, i.id), isNull(person.companyId)));
      return { id: row.id, email: i.email };
    },
  }),
  defineAction({
    name: "person.update",
    description:
      "Change a person: name, notes, company (a company id, or null for none), or the owner's own fields (replaces them all).",
    input: z.object({
      id,
      name: name.optional(),
      notes: body.optional(),
      companyId: id.nullable().optional(),
      fields: fields.optional(),
    }),
    risk: "internal",
    async handler(i, ctx) {
      await livePerson(ctx, i.id);
      if (i.companyId && !(await liveEntity(ctx.tx, i.companyId, "company")))
        throw new ActionError("not_found", "No such company");
      await ensureProfile(ctx, i.id);
      const set = {
        ...(i.companyId !== undefined ? { companyId: i.companyId } : {}),
        ...(i.fields ? { fields: i.fields } : {}),
      };
      if (Object.keys(set).length)
        await ctx.tx.update(person).set(set).where(eq(person.entityId, i.id));
      return updateEntity(ctx, i.id, { title: i.name, body: i.notes }, { type: "person" });
    },
  }),
  defineAction({
    name: "person.follow_up",
    description:
      "Remind the owner to get in touch when they haven't talked to this person (email or a meeting) for this many days. null turns it off.",
    input: z.object({ id, days: z.number().int().min(1).max(3650).nullable() }),
    risk: "internal",
    async handler(i, ctx) {
      await livePerson(ctx, i.id);
      await ensureProfile(ctx, i.id);
      await ctx.tx.update(person).set({ followUpDays: i.days }).where(eq(person.entityId, i.id));
      return { id: i.id, followUpDays: i.days };
    },
  }),
  defineAction({
    name: "person.list",
    description: "List people by name, with their company and when you last talked.",
    input: z.object({
      limit: z.number().int().min(1).max(200).default(200),
      companyId: id.optional(),
    }),
    risk: "read",
    handler: (i, ctx) => listPeople(ctx.tx, ctx.now, i),
  }),
  defineAction({
    name: "person.view",
    description:
      "Everything about a person: addresses, company, when you last talked, and their linked conversations, meetings, tasks and notes.",
    input: z.object({ id }),
    risk: "read",
    async handler(i, ctx) {
      return personView(ctx.tx, await livePerson(ctx, i.id), ctx.now);
    },
  }),
];

const companyActions = [
  defineAction({
    name: "company.list",
    description: "List companies, with how many of their people you know.",
    input: z.object({ limit: z.number().int().min(1).max(200).default(200) }),
    risk: "read",
    handler: (i, ctx) =>
      ctx.tx
        .select({
          id: entity.id,
          name: entity.title,
          domain: company.domain,
          people: count(person.entityId),
        })
        .from(company)
        .innerJoin(entity, eq(entity.id, company.entityId))
        .leftJoin(person, eq(person.companyId, company.entityId))
        .where(isNull(entity.deletedAt))
        .groupBy(entity.id, entity.title, company.domain)
        .orderBy(asc(entity.title))
        .limit(i.limit),
  }),
  defineAction({
    name: "company.view",
    description: "A company: its domain, notes and the people you know there.",
    input: z.object({ id }),
    risk: "read",
    async handler(i, ctx) {
      const row = await liveEntity(ctx.tx, i.id, "company");
      if (!row) throw new ActionError("not_found", "No such company");
      const [c] = await ctx.tx.select().from(company).where(eq(company.entityId, i.id));
      return {
        id: row.id,
        name: row.title,
        notes: row.body ?? "",
        domain: c?.domain ?? "",
        people: await listPeople(ctx.tx, ctx.now, { companyId: i.id, limit: 200 }),
      };
    },
  }),
  defineAction({
    name: "company.update",
    description: "Rename a company or change its notes.",
    input: z.object({ id, name: name.optional(), notes: body.optional() }),
    risk: "internal",
    handler: (i, ctx) =>
      updateEntity(ctx, i.id, { title: i.name, body: i.notes }, { type: "company" }),
  }),
  defineAction({
    name: "people.tidy",
    description:
      "Housekeeping: gives people added before companies existed their profile and company.",
    input: z.object({}),
    risk: "internal",
    async handler(_i, ctx) {
      const rows = await ctx.tx
        .select({ id: entity.id })
        .from(entity)
        .leftJoin(person, eq(person.entityId, entity.id))
        .where(and(eq(entity.type, "person"), isNull(entity.deletedAt), isNull(person.entityId)))
        .limit(500);
      for (const r of rows) await ensureProfile(ctx, r.id);
      return { profiles: rows.length };
    },
  }),
];

export const peopleModule = defineModule({
  name: "people",
  description:
    "People and companies you know, built from mail and meetings, and agents like Jarvis.",
  entityTypes: ["person", "company", "agent"],
  events: [],
  knowledge: {
    async person(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "person");
      if (!row) return null;
      const rules = await getSetting(ctx.db, "owner.dayRules");
      const v = await personView(ctx.db, row, ctx.now);
      return describeRow(
        row,
        [],
        personFacts(v, (d) => formatDateTime(d, rules.timeZone)),
      );
    },
    async company(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "company");
      if (!row) return null;
      const people = await listPeople(ctx.db, ctx.now, { companyId: entityId, limit: 50 });
      const tail = people.map((p) => `- ${p.name} (person ${p.id})`).join("\n");
      return describeRow(row, ["a company"], tail ? `People:\n${tail}` : "");
    },
    async agent(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "agent");
      return row ? describeRow(row, ["an AI agent"]) : null;
    },
  },
  actions: [...personActions, ...companyActions],
  reflexes: [],
  noReflexesBecause:
    "Follow-ups are a daily digest line, not a reaction to any one event; mail and calendar sync link people as they go.",
  routines: [
    {
      name: "people.tidy",
      description: "Each night, gives people without a company profile one.",
      cron: "15 4 * * *",
      staleAfterSeconds: null,
      run: async () => [{ kind: "act", action: "people.tidy", input: {} }],
    },
  ],
  /** "You haven't talked to Ana in 64 days" for each person whose follow-up has come due. */
  async digest(ctx): Promise<DigestItem[]> {
    const rows = await ctx.db
      .select({ e: entity, days: person.followUpDays })
      .from(person)
      .innerJoin(entity, eq(entity.id, person.entityId))
      .where(and(isNotNull(person.followUpDays), isNull(entity.deletedAt)))
      .limit(500);
    const last = await lastContacts(
      ctx.db,
      rows.map((r) => r.e.id),
      ctx.now,
    );
    return rows.flatMap(({ e, days }) => {
      const late = overdue(days, last.get(e.id), e.createdAt, ctx.now);
      if (late === null) return [];
      return [
        {
          bucket: "today" as const,
          text: last.has(e.id)
            ? `You haven't talked to ${e.title} in ${late} days.`
            : `You haven't talked to ${e.title} since adding them ${late} days ago.`,
          entityId: e.id,
          // A name from mail or an invitation is what the sender called themselves.
          outside: isOutside(e),
        },
      ];
    });
  },
});
