// Mail that needs your reply during the day: set aside for Jarvis's next heartbeat, which drafts
// the reply within about 25 minutes. Watching is free; only the heartbeat spends a turn, and only
// on what was set aside. Overnight mail is left to the 7:45 reply drafts.
import { minuteOfDay, startOfLocalDay } from "@hearth/core";
import { event, heartbeatItem } from "@hearth/db";
import { getSetting, type ReflexDef } from "@hearth/kernel";
import { and, count, eq, gte, isNull } from "drizzle-orm";
import { listThreads, who } from "./views.ts";
import { threadsToDraft } from "./waiting.ts";

/** Emails set aside for drafting in one day, so a burst of mail can't eat the turn budget. */
export const DAYTIME_DRAFTS = 15;
/** How an email set aside for the heartbeat is worded: the heartbeat looks for it. */
export const NEEDS_REPLY = "Email needing your reply";
/** From the morning's reply drafts (7:45) to the day's last heartbeat (18:50). */
const DAY_FROM = 7 * 60 + 45;
const DAY_UNTIL = 18 * 60 + 50;

export const newMailNeedsReply: ReflexDef = {
  name: "mail.needs_reply",
  description: `During the day, an email that needs your reply gets a draft from Pip within about 25 minutes (up to ${DAYTIME_DRAFTS} a day). Nothing is sent.`,
  mode: "proactive",
  on: ["mail.received"],
  async run(ev, ctx) {
    const threadId = typeof ev.payload.threadId === "string" ? ev.payload.threadId : null;
    if (!threadId) return [];
    const { timeZone } = await getSetting(ctx.db, "owner.dayRules");
    const minute = minuteOfDay(ctx.now, timeZone);
    if (minute < DAY_FROM || minute >= DAY_UNTIL) return [];
    // The same rule as the morning drafts: Signal, in the inbox, waiting on you, no draft yet.
    if ((await threadsToDraft(ctx, threadId)).length === 0) return [];
    // A second message in the same conversation before the heartbeat: one item is enough.
    const [waiting] = await ctx.db
      .select({ id: heartbeatItem.id })
      .from(heartbeatItem)
      .where(and(eq(heartbeatItem.aboutId, threadId), isNull(heartbeatItem.takenAt)))
      .limit(1);
    if (waiting) return [];
    const [today] = await ctx.db
      .select({ n: count() })
      .from(heartbeatItem)
      .innerJoin(event, eq(event.seq, heartbeatItem.sourceEventSeq))
      .where(
        and(
          eq(event.kind, "mail.received"),
          gte(heartbeatItem.createdAt, startOfLocalDay(ctx.now, timeZone)),
        ),
      );
    if ((today?.n ?? 0) >= DAYTIME_DRAFTS) return [];
    const [t] = await listThreads(ctx.db, { view: "any", ids: [threadId], limit: 1 });
    if (!t) return [];
    const them = t.participants.find((p) => p.address !== t.account);
    return [
      {
        kind: "batch",
        text: `${NEEDS_REPLY}, from ${them ? who(them) : "someone"}: ${t.subject}`,
        aboutId: threadId,
      },
    ];
  },
};
