// Passing a member's message on to you (D62): a record of what they wrote and a card in the inbox.
// Their words are outside content, so the record is marked outside, and whoever passes it on
// (the member's own turn, or the take loop as the Slack integration) is outside too: nothing here
// calls Jarvis or starts a turn with your rights, and the text can't carry Hearth's link tags.
// One card per member an hour: later messages that hour go under the first one's record, which
// lists them. A VIP's message marked urgent may interrupt you, once a day, within D60's limit.
import { localDate, localParts, startOfLocalDay } from "@hearth/core";
import { type DbOrTx, entity, notification } from "@hearth/db";
import { type ActionContext, createEntity, createNotification, getSetting } from "@hearth/kernel";
import { and, eq, gte, isNull, ne } from "drizzle-orm";
import { preview } from "../../shared.ts";
import { named } from "../save.ts";

/** The record type of a member's message passed on to you. */
export const RELAY_TYPE = "slack_member_message";

/** Why it's passed on. */
export type RelayKind = "message" | "meeting" | "unanswered";

export interface Relay {
  principal: string;
  /** Their name, cleaned (people.ts cleanName). */
  name: string;
  /** What they wrote, as plain text. */
  text: string;
  kind: RelayKind;
  urgent?: boolean;
  vip?: boolean;
}

const TITLES: Record<RelayKind, (name: string) => string> = {
  message: (n) => `${n} left you a message on Slack`,
  meeting: (n) => `${n} asked to meet, on Slack`,
  unanswered: (n) => `${n} wrote to the Jarvis bot on Slack, and it couldn't answer`,
};

/** The hour a card is for, in your time zone: "2026-10-05T14". */
const hourOf = (now: Date, timeZone: string) =>
  `${localDate(now, timeZone)}T${String(localParts(now, timeZone).hour).padStart(2, "0")}`;

/** The card a key made, while you haven't dealt with it. */
async function openCard(db: DbOrTx, key: string) {
  const [card] = await db
    .select({ id: notification.id, entityId: notification.entityId })
    .from(notification)
    .where(and(eq(notification.dedupeKey, key), ne(notification.state, "done")));
  return card ?? null;
}

/** Whether a member's messages already interrupted you today. */
async function interruptedToday(ctx: ActionContext, principal: string, timeZone: string) {
  const [row] = await ctx.tx
    .select({ id: notification.id })
    .from(notification)
    .where(
      and(
        eq(
          notification.dedupeKey,
          `slack.member.urgent:${principal}:${localDate(ctx.now, timeZone)}`,
        ),
        gte(notification.createdAt, startOfLocalDay(ctx.now, timeZone)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Passes a member's message on: the record, and the card for it. Returns the record's id.
 * `text` should already be plain text (save.ts plainText); it's neutralized again here, so nothing
 * passed on can be read as a link to one of your records.
 */
export async function passOn(ctx: ActionContext, r: Relay): Promise<string> {
  const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
  const body = named(r.text).slice(0, 4000);
  const title = TITLES[r.kind](named(r.name));
  // A meeting request is a card of its own; messages share their hour's.
  const hourKey = `slack.member:${r.principal}:${hourOf(ctx.now, timeZone)}`;
  const card = r.kind === "meeting" ? null : await openCard(ctx.tx, hourKey);
  const record = await createEntity(ctx, {
    type: RELAY_TYPE,
    title: title.slice(0, 300),
    body,
    outside: true,
    ...(card?.entityId ? { parentId: card.entityId } : {}),
  });
  const interrupt =
    r.vip === true && r.urgent === true && !(await interruptedToday(ctx, r.principal, timeZone));
  if (card && !interrupt) return record.id;
  await createNotification(ctx, {
    kind: r.kind === "meeting" ? "slack.member_meeting" : "slack.member",
    title: r.urgent ? `Urgent: ${title}` : title,
    body: preview(body, 300),
    entityId: record.id,
    urgency: interrupt ? "interrupt" : "normal",
    lane: "signal",
    dedupeKey: interrupt
      ? `slack.member.urgent:${r.principal}:${localDate(ctx.now, timeZone)}`
      : r.kind === "meeting"
        ? `slack.member_meeting:${record.id}`
        : hourKey,
  });
  return record.id;
}

/** The later messages passed on under a record, in the hour its card is for. */
export function laterMessages(db: DbOrTx, id: string) {
  return db
    .select({ body: entity.body, createdAt: entity.createdAt })
    .from(entity)
    .where(and(eq(entity.parentId, id), eq(entity.type, RELAY_TYPE), isNull(entity.deletedAt)))
    .orderBy(entity.createdAt)
    .limit(50);
}
