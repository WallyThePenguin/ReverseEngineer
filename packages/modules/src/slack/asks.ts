// A Slack message for you (an @mention or a direct message): set aside for Jarvis's next
// heartbeat, which makes a task of it if it asks you to do something. Watching is free; only the
// heartbeat spends a turn. Hearth never posts to Slack.
import { startOfLocalDay } from "@hearth/core";
import { type DbOrTx, entity, event, heartbeatItem, link } from "@hearth/db";
import { getSetting, type ReflexDef } from "@hearth/kernel";
import { and, count, eq, gte, isNull } from "drizzle-orm";
import { liveEntity } from "../shared.ts";

/** Slack messages set aside in one day, so a busy channel can't flood the heartbeat. */
export const SLACK_ASKS = 15;
/** How a Slack message set aside for the heartbeat is worded: the heartbeat looks for it. */
export const SLACK_FOR_YOU = "Slack message for you";

/** A task that links to this record (an m-ref in its body, say), if one is still around. */
export async function taskAbout(db: DbOrTx, recordId: string): Promise<string | null> {
  const [t] = await db
    .select({ id: entity.id })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(and(eq(link.toId, recordId), eq(entity.type, "task"), isNull(entity.deletedAt)))
    .limit(1);
  return t?.id ?? null;
}

export const slackForYou: ReflexDef = {
  name: "slack.for_you",
  description: `When someone @mentions you or messages you on Slack, Jarvis makes a task of it at its next heartbeat if it asks you to do something (up to ${SLACK_ASKS} a day). Nothing is posted.`,
  mode: "proactive",
  on: ["slack.mentioned"],
  async run(ev, ctx) {
    const id = ev.entityId;
    if (!id) return [];
    const message = await liveEntity(ctx.db, id, "slack_message");
    if (!message || (await taskAbout(ctx.db, id))) return [];
    const { timeZone } = await getSetting(ctx.db, "owner.dayRules");
    const [today] = await ctx.db
      .select({ n: count() })
      .from(heartbeatItem)
      .innerJoin(event, eq(event.seq, heartbeatItem.sourceEventSeq))
      .where(
        and(
          eq(event.kind, "slack.mentioned"),
          gte(heartbeatItem.createdAt, startOfLocalDay(ctx.now, timeZone)),
        ),
      );
    if ((today?.n ?? 0) >= SLACK_ASKS) return [];
    return [{ kind: "batch", text: `${SLACK_FOR_YOU}: ${message.title}`, aboutId: id }];
  },
};
