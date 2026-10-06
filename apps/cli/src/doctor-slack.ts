// `hearth doctor`'s line for Jarvis's Slack bot (D62): whether people can talk to it, what it did
// with what they wrote in the last day, and any post that didn't go out. The socket's own health
// is the sync.slack_bot line; this one says what the bot did. Slack's trouble is never a fail
// here either: an update can't fix it, so the update's doctor mustn't roll one back over it.
import { type Db, slackBot, slackInbound, slackOutbox } from "@hearth/db";
import { getSetting } from "@hearth/kernel";
import { and, count, eq, gte, inArray } from "drizzle-orm";
import type { Check } from "./doctor.ts";

const DAY_MS = 86_400_000;

/** Null when no bot is connected: there's nothing to say. */
export async function checkSlackBot(db: Db, now: Date): Promise<Check | null> {
  const [bot] = await db.select().from(slackBot).limit(1);
  if (!bot) return null;
  const name = "Jarvis's Slack bot";
  const since = new Date(now.getTime() - DAY_MS);
  const membersOn = await getSetting(db, "slack.bot.membersOn");
  const outcomes = await db
    .select({ outcome: slackInbound.outcome, n: count() })
    .from(slackInbound)
    .where(and(eq(slackInbound.teamId, bot.teamId), gte(slackInbound.takenAt, since)))
    .groupBy(slackInbound.outcome);
  const n = (o: string) => outcomes.find((r) => r.outcome === o)?.n ?? 0;
  const [lost] = await db
    .select({ n: count() })
    .from(slackOutbox)
    .where(
      and(
        eq(slackOutbox.teamId, bot.teamId),
        inArray(slackOutbox.state, ["failed", "expired", "unknown"]),
        gte(slackOutbox.createdAt, since),
      ),
    );
  const people = membersOn ? "People in your Slack can talk to it" : "Members are off";
  const did = `in the last 24 hours it answered ${n("answered")}, passed ${n("relayed")} on to you, and took ${n("yours")} from you`;
  const notOut = lost?.n ?? 0;
  if (bot.syncState === "revoked")
    return { name, mark: "warn", detail: "Slack revoked it: reconnect it in Settings → Slack." };
  if (notOut)
    return {
      name,
      mark: "warn",
      detail: `${people}; ${did}. ${notOut} post(s) didn't go out: they're in your inbox.`,
    };
  return { name, mark: "ok", detail: `${people}; ${did}.` };
}
