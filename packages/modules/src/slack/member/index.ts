// What a Slack member's turn can do (D62): exactly three actions name `member`, plus slack.reply,
// which only the runner calls. Each takes who's asking from the caller and reads their tier again
// itself, so a turn can't use a tier you've since lowered:
// - member.free_time (schedule): your free slots in working hours, rounded to 30 minutes, with no
//   titles, guests or places;
// - member.leave_message (relay and up): passes their message on to you, as an outside record and
//   a card;
// - member.request_meeting (schedule): a request card for you. It books nothing; you schedule
//   through calendar.schedule_meeting as usual.
// None of them reads a record, a person, a conversation or anything else of yours.
import { formatDateTime } from "@hearth/core";
import { defineAction, defineModule, getSetting } from "@hearth/kernel";
import { z } from "zod";
import { freeSlots } from "../../calendar/free.ts";
import { describeRow, isoDateTime, liveEntity, preview } from "../../shared.ts";
import { plainText } from "../save.ts";
import { needTier } from "./people.ts";
import { laterMessages, passOn, RELAY_TYPE } from "./relay.ts";

const HALF_HOUR = 30 * 60_000;
const DAY_MS = 86_400_000;
/** The most slots a member is shown. */
const MAX_SLOTS = 20;

/** The tier each member action needs: what the runner offers a member, and what it checks. */
export const MEMBER_TIERS = {
  "member.free_time": "schedule",
  "member.leave_message": "relay",
  "member.request_meeting": "schedule",
} as const;

/** A slot shrunk to whole half hours: it starts on one and ends on one. */
export function onHalfHours(s: { start: Date; end: Date }) {
  const start = new Date(Math.ceil(s.start.getTime() / HALF_HOUR) * HALF_HOUR);
  const end = new Date(Math.floor(s.end.getTime() / HALF_HOUR) * HALF_HOUR);
  return { start, end };
}

/** Their words as plain text: Slack's markup read out, and no link tags of Hearth's. */
const theirWords = (text: string) => plainText(text, new Map()).trim();

export const memberModule = defineModule({
  name: "member",
  description:
    "What someone in your Slack workspace can ask Jarvis for: your free time, a message passed on to you, or a meeting request. Only their own Jarvis turns call these.",
  entityTypes: [RELAY_TYPE],
  // Members write these: reading one makes the rest of a turn untrusted (D58, D62).
  outsideTypes: [RELAY_TYPE],
  events: [],
  kernelEvents: ["entity.created", "notification.created"],
  knowledge: {
    async [RELAY_TYPE](entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, RELAY_TYPE);
      if (!row) return null;
      const later = await laterMessages(ctx.db, entityId);
      const tail = later.length
        ? [
            "## Later messages",
            ...later.map((l) => `- ${formatDateTime(l.createdAt)}: ${preview(l.body, 500)}`),
          ].join("\n")
        : "";
      return describeRow(row, ["written by someone in your Slack"], tail);
    },
  },
  actions: [
    defineAction({
      name: "member.free_time",
      description:
        "The owner's free time in working hours over the next days, as start and end times only. Use it when they ask when the owner is free.",
      input: z.object({
        minutes: z.number().int().min(15).max(240).default(30),
        days: z.number().int().min(1).max(10).default(5),
      }),
      risk: "read",
      callers: ["member"],
      async handler(i, ctx) {
        await needTier(ctx, MEMBER_TIERS["member.free_time"]);
        const rules = await getSetting(ctx.tx, "owner.dayRules");
        const to = new Date(ctx.now.getTime() + i.days * DAY_MS);
        const slots = (await freeSlots(ctx.tx, ctx.now, to, i.minutes, rules))
          .map(onHalfHours)
          .filter((s) => s.end.getTime() - s.start.getTime() >= i.minutes * 60_000)
          .slice(0, MAX_SLOTS);
        // Times only: what's on the calendar around them is the owner's.
        return { slots, timeZone: rules.timeZone };
      },
    }),
    defineAction({
      name: "member.leave_message",
      description:
        "Pass a message on to the owner, who reads it in Hearth. Use it when they want the owner to know something, or you can't help them.",
      input: z.object({
        text: z.string().trim().min(1).max(2000),
        urgent: z.boolean().default(false),
      }),
      risk: "internal",
      callers: ["member"],
      async handler(i, ctx) {
        const m = await needTier(ctx, MEMBER_TIERS["member.leave_message"]);
        await passOn(ctx, {
          principal: ctx.caller.principal,
          name: m.name,
          text: theirWords(i.text),
          kind: "message",
          urgent: i.urgent,
          vip: m.user.vip,
        });
        return { passedOn: true, note: "The owner will see it in Hearth." };
      },
    }),
    defineAction({
      name: "member.request_meeting",
      description:
        "Ask the owner for a meeting: how long, up to three times that suit them, and what it's about. It books nothing; the owner decides.",
      input: z.object({
        minutes: z.number().int().min(15).max(240).default(30),
        options: z.array(isoDateTime).max(3).default([]),
        about: z.string().trim().max(500).default(""),
      }),
      risk: "internal",
      callers: ["member"],
      async handler(i, ctx) {
        const m = await needTier(ctx, MEMBER_TIERS["member.request_meeting"]);
        const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
        const times = i.options.map((o) => `- ${formatDateTime(new Date(o), timeZone)}`);
        const text = [
          `Asked for ${i.minutes} minutes${i.about ? ` about: ${theirWords(i.about)}` : "."}`,
          ...(times.length ? ["", "Times that suit them:", ...times] : []),
        ].join("\n");
        await passOn(ctx, { principal: ctx.caller.principal, name: m.name, text, kind: "meeting" });
        return { requested: true, booked: false, note: "The owner decides, and books it." };
      },
    }),
  ],
  reflexes: [],
  noReflexesBecause:
    "A member's words only make cards for you: nothing they write starts a turn with your rights (D62).",
});
