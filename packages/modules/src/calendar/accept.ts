// Jarvis accepting an invitation without asking (D71): only a yes, only from someone you know or a
// colleague, only when you're free (every time in the next 4 weeks, for a repeating meeting). The
// handler checks it all again as it runs; anything else is calendar.respond, which asks you.
import { type DbOrTx, entity, personEmail } from "@hearth/db";
import { ActionError, defineAction, getSetting } from "@hearth/kernel";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { plainTitle } from "./actions.ts";
import { ACCEPTED, AUTO_ACCEPTS, acceptedToday, cannotAccept } from "./invites.ts";
import { answer } from "./respond.ts";
import { loadEvent } from "./store.ts";
import { shortWhen, tellDone } from "./undo.ts";

/** Who it's from as you know them: your name for them, or their address. */
async function from(db: DbOrTx, address: string): Promise<string> {
  const [p] = await db
    .select({ name: entity.title })
    .from(personEmail)
    .innerJoin(entity, eq(entity.id, personEmail.personId))
    .where(and(eq(personEmail.address, address), isNull(entity.deletedAt)));
  return (
    p?.name
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .trim()
      .slice(0, 60) || address
  );
}

export const acceptInviteAction = defineAction({
  name: "calendar.accept_invite",
  description:
    "Accept an invitation for the owner without asking. Only when Hearth can tell it's safe: on their own calendar, from someone they know or a colleague, and nothing of theirs overlaps it (for a repeating meeting, every time in the next 4 weeks). It only ever accepts, and only in a conversation the owner started that hasn't read outside content. Anything else is refused: use calendar_respond, which asks the owner.",
  input: z.object({ id }),
  risk: "internal",
  callers: ["agent"],
  async handler(i, ctx) {
    const ask = (why: string) =>
      new ActionError("forbidden", `${why} Use calendar_respond; it asks first.`);
    // A turn the owner started, or Hearth itself as a new invitation comes in: then within the
    // day's count and not while Jarvis is paused. Never a turn that read outside content.
    if (ctx.caller.turnId) {
      if (ctx.caller.origin !== "owner") throw ask("This conversation read outside content.");
    } else {
      if (await getSetting(ctx.tx, "jarvis.paused")) throw ask("Jarvis is paused.");
      if ((await acceptedToday(ctx.tx, ctx.now)) >= AUTO_ACCEPTS)
        throw ask(`Jarvis has accepted ${AUTO_ACCEPTS} invitations on its own today.`);
    }
    const ev = await loadEvent(ctx.tx, i.id);
    if (!ev) throw new ActionError("not_found", "Event not found");
    const why = await cannotAccept(ctx.tx, ev, ctx.now);
    if (why) throw ask(why);
    const scope = ev.recurringEventId ? "all" : "this";
    const saved = await answer(ctx, ev, "accepted", scope === "all" ? "all" : undefined, true);
    const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
    const who = await from(ctx.tx, ev.organizer!);
    await tellDone(
      ctx,
      {
        kind: ACCEPTED,
        title: `Accepted ${plainTitle(ev.title)}, ${shortWhen(ev, timeZone)}`,
        // The address first: a name and a title are whatever the sender typed.
        body: `From ${ev.organizer}${who === ev.organizer ? "" : ` (${plainTitle(who)})`}. ${
          scope === "all"
            ? "It repeats; you were free every time in the next 4 weeks."
            : "You were free then."
        }`,
        entityId: ev.id,
      },
      { kind: "unaccept", eventId: ev.id, before: { scope } },
    );
    return saved;
  },
});
