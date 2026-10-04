// Jarvis's own routines. Prep (6 a.m.) and memory consolidation arrive with calendar and memory
// in M1; the heartbeat lives in the Jarvis runtime because it batches across all modules.
import { localDate } from "@hearth/core";
import { entity } from "@hearth/db";
import { getSetting, type RoutineDef } from "@hearth/kernel";
import { and, desc, eq, isNull } from "drizzle-orm";
import { hasOutside, renderBrief, renderDigest, withoutOutside } from "./brief.ts";

const DAY_MS = 24 * 3600_000;

export const briefRoutine: RoutineDef = {
  name: "brief",
  description: "The morning brief at 8:15 a.m.: handled, prepared, needs a yes, then today.",
  cron: "15 8 * * *",
  staleAfterSeconds: 4 * 3600,
  async run(firing, ctx) {
    const [last] = await ctx.db
      .select({ at: entity.createdAt })
      .from(entity)
      .where(and(eq(entity.type, "brief"), isNull(entity.deletedAt)))
      .orderBy(desc(entity.createdAt))
      .limit(1);
    const since = last?.at ?? new Date(firing.scheduledFor.getTime() - DAY_MS);
    const sections = await firing.digest(since);
    const draft = renderBrief(sections, ctx.now);
    const rules = await getSetting(ctx.db, "owner.dayRules");
    // The day it was due, even when it runs late (D54).
    const date = localDate(firing.scheduledFor, rules.timeZone);
    return [
      {
        kind: "turn",
        trigger: "routine",
        lane: "deep",
        dedupeKey: `brief:${date}`,
        untrusted: hasOutside(sections),
        context: { routine: "brief", date },
        prompt: [
          `It's time for the morning brief (${date}).`,
          "Rewrite the facts below into a short brief: lead with what was handled, then what's prepared, then what needs a yes, then today.",
          "Look up anything you need to make it useful (open tasks, the records involved). Don't invent facts.",
          "Then call brief_publish with the markdown and this date.",
          "",
          draft,
        ].join("\n"),
        fallback: [{ kind: "act", action: "brief.publish", input: { markdown: draft, date } }],
      },
    ];
  },
};

export const journalRoutine: RoutineDef = {
  name: "journal",
  description: "The evening journal at 7:30 p.m.: what happened today, kept as a record.",
  cron: "30 19 * * *",
  staleAfterSeconds: 6 * 3600,
  async run(firing, ctx) {
    const rules = await getSetting(ctx.db, "owner.dayRules");
    // The day it was due, even when it runs late (D54).
    const date = localDate(firing.scheduledFor, rules.timeZone);
    // Its day starts 14 hours before it was due, so running late doesn't lose the morning.
    const since = new Date(firing.scheduledFor.getTime() - 14 * 3600_000);
    // The journal feeds the nightly memory update, so it's written from Hearth's own facts only.
    const facts = renderDigest(withoutOutside(await firing.digest(since)));
    return [
      {
        kind: "turn",
        trigger: "routine",
        lane: "deep",
        dedupeKey: `journal:${date}`,
        context: { routine: "journal", date },
        prompt: [
          `Write today's journal entry (${date}): what happened, what moved, what's still open, anything worth remembering.`,
          "Use the facts below and look up records as needed. Keep it short. Then call journal_write.",
          "",
          facts,
        ].join("\n"),
        fallback: [{ kind: "act", action: "journal.write", input: { markdown: facts, date } }],
      },
    ];
  },
};
