// People who aren't: Hearth used to make a person for one of your own addresses (writing to your
// other account) or for a desk's (support@, billing@…). Each night people.tidy puts the ones it
// made in the trash, if you haven't touched them; anything you wrote, named or set stays.
import { entity, person, personEmail } from "@hearth/db";
import { type ActionContext, trashEntity } from "@hearth/kernel";
import { and, eq, isNull, like, or } from "drizzle-orm";
import { accountAddresses, addressKey } from "../mail/mine.ts";
import { isRoleAddress } from "./domains.ts";

/** Puts the people Hearth made for your own or a desk's address in the trash; how many. */
export async function trashNotPeople(ctx: ActionContext): Promise<number> {
  const rows = await ctx.tx
    .select({
      id: entity.id,
      body: entity.body,
      address: personEmail.address,
      followUp: person.followUpDays,
      fields: person.fields,
    })
    .from(entity)
    .innerJoin(personEmail, eq(personEmail.personId, entity.id))
    .leftJoin(person, eq(person.entityId, entity.id))
    .where(
      and(
        eq(entity.type, "person"),
        isNull(entity.deletedAt),
        // As Hearth made it: the notes still just its address, and changed since, if at all,
        // only by a sync (a better name from later mail), never by you or Jarvis.
        like(entity.body, "Email: %"),
        or(
          eq(entity.revision, 1),
          like(entity.updatedBy, "integration:%"),
          eq(entity.updatedBy, "system"),
        ),
      ),
    )
    .limit(2_000);
  const mine = await accountAddresses(ctx.tx);
  const notAPerson = (address: string) => mine.has(addressKey(address)) || isRoleAddress(address);
  const people = new Map<string, { body: string; addresses: string[]; yours: boolean }>();
  for (const r of rows) {
    const p = people.get(r.id) ?? { body: r.body ?? "", addresses: [], yours: false };
    p.addresses.push(r.address);
    // A follow-up or a field of your own on them is you keeping them.
    p.yours ||= r.followUp !== null || Object.keys(r.fields ?? {}).length > 0;
    people.set(r.id, p);
  }
  let trashed = 0;
  for (const [id, p] of people) {
    const untouched = p.addresses.some((a) => p.body === `Email: ${a}`) && !p.yours;
    if (!untouched || !p.addresses.every(notAPerson)) continue;
    await trashEntity(ctx, id);
    trashed++;
  }
  return trashed;
}
