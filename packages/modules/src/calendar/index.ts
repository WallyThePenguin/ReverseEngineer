// Google Calendar, two-way: your events synced in every few minutes, Jarvis writing your own
// calendar directly and asking before anything guests would see, prep packets each morning,
// conflict warnings, and time blocks for big tasks (PLAN.md sections 6.1, 6.2 and 8.2).
import { formatTime, localDate } from "@hearth/core";
import {
  calendar,
  calendarEvent,
  entity,
  googleAccount,
  mailAccount,
  mailDraft,
  mailMessage,
  mailThread,
} from "@hearth/db";
import {
  type DigestItem,
  defineAction,
  defineModule,
  getSetting,
  type ReflexDef,
} from "@hearth/kernel";
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { GOOGLE_SERVICE, type GoogleClient } from "../google/client.ts";
import { describeRow, id, isOutside, isoDateTime, liveEntity } from "../shared.ts";
import { calendarWriteActions } from "./actions.ts";
import { blockAction, blockReflex, blockRoutine } from "./blocks.ts";
import { freeSlots } from "./free.ts";
import { prepPublish, prepRoutine } from "./prep.ts";
import { guests, loadEvent, toEventView, whenText } from "./store.ts";
import { syncCalendars } from "./sync.ts";

const DAY_MS = 24 * 3600_000;

const conflicts: ReflexDef = {
  name: "calendar.conflicts",
  description:
    "When an event lands on top of another, you hear about it; if it lands on a task's time block, the block moves.",
  mode: "proactive",
  on: ["calendar.event_changed"],
  async run(event, ctx) {
    if (!event.entityId || event.payload.change === "cancelled") return [];
    const ev = await loadEvent(ctx.db, event.entityId);
    if (!ev || ev.allDay || !ev.busy || ev.selfResponse === "declined") return [];
    const rows = await ctx.db
      .select({ e: entity, r: calendarEvent })
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
      .where(
        and(
          ne(calendarEvent.entityId, ev.id),
          ne(calendarEvent.status, "cancelled"),
          eq(calendarEvent.allDay, false),
          eq(calendarEvent.busy, true),
          lt(calendarEvent.startsAt, ev.endsAt),
          gt(calendarEvent.endsAt, ev.startsAt),
        ),
      );
    const rules = await getSetting(ctx.db, "owner.dayRules");
    const out = [];
    for (const { e, r } of rows) {
      if (r.selfResponse === "declined") continue;
      // A meeting and a focus block: plan the task again around the meeting.
      const block = r.taskId && !ev.taskId ? r.taskId : !r.taskId && ev.taskId ? ev.taskId : null;
      if (block) {
        out.push({
          kind: "check_later" as const,
          key: `block:${block}`,
          at: new Date(event.at.getTime() + 60_000),
          payload: { taskId: block },
        });
        continue;
      }
      if (r.taskId) continue;
      const [a, b] = [ev.id, e.id].sort();
      out.push({
        kind: "tell" as const,
        notification: {
          kind: "calendar.conflict",
          title: `"${ev.title}" overlaps "${e.title}"`,
          body: `${whenText(ev, rules.timeZone)} and ${whenText(toEventView(e, r), rules.timeZone)}.`,
          entityId: ev.id,
          urgency: "normal" as const,
          dedupeKey: `conflict:${a}:${b}`,
        },
      });
    }
    return out;
  },
  async onCheck(payload) {
    return [{ kind: "act", action: "calendar.block_task", input: { taskId: payload.taskId } }];
  },
};

const syncFailed: ReflexDef = {
  name: "calendar.sync_failed",
  description: "When Google Calendar stops syncing, you get one notice a day about it.",
  mode: "always",
  on: ["calendar.sync_failed"],
  async run(event, ctx) {
    const rules = await getSetting(ctx.db, "owner.dayRules");
    const errors = (event.payload.errors as string[] | undefined) ?? [];
    return [
      {
        kind: "tell",
        notification: {
          kind: "system.alert",
          title: "Google Calendar isn't syncing",
          body: errors.join("\n").slice(0, 1000),
          urgency: "normal",
          dedupeKey: `calendar.sync_failed:${localDate(event.at, rules.timeZone)}`,
        },
      },
    ];
  },
};

const noRoom: ReflexDef = {
  name: "calendar.no_room",
  description: "When a big task can't fit before it's due, you're told so you can decide.",
  mode: "proactive",
  on: ["calendar.no_room"],
  run(event) {
    const hours = Math.round((Number(event.payload.minutesShort) / 60) * 10) / 10;
    return [
      {
        kind: "tell",
        notification: {
          kind: "calendar.no_room",
          title: `No room for "${event.payload.title}"`,
          body: `About ${hours} hours of it don't fit in your free working time before it's due. Move the due date, shorten the estimate, or clear some time.`,
          entityId: event.entityId,
          urgency: "normal",
          dedupeKey: `no_room:${event.entityId}:${String(event.payload.dueAt)}`,
        },
      },
    ];
  },
};

export const calendarModule = defineModule({
  name: "calendar",
  description: "Google Calendar: your events, prep packets and time blocks for big tasks.",
  entityTypes: ["event", "prep"],
  events: [
    {
      kind: "calendar.event_changed",
      description:
        "An upcoming event was added, moved, changed or cancelled. Payload: change, title, startsAt, endsAt.",
    },
    {
      kind: "calendar.sync_failed",
      description: "Syncing with Google failed for some calendars. Payload: errors.",
    },
    {
      kind: "calendar.no_room",
      description: "A big task doesn't fit before it's due. Payload: title, minutesShort, dueAt.",
    },
  ],
  kernelEvents: ["entity.created", "entity.updated", "link.added"],
  knowledge: {
    async event(entityId, ctx) {
      const ev = await loadEvent(ctx.db, entityId);
      const row = await liveEntity(ctx.db, entityId, "event");
      if (!ev || !row) return null;
      const rules = await getSetting(ctx.db, "owner.dayRules");
      const extra = [whenText(ev, rules.timeZone)];
      if (ev.status !== "confirmed") extra.push(ev.status);
      if (ev.location) extra.push(`at ${ev.location}`);
      const people = guests(ev);
      const tail = [
        people.length
          ? `Guests: ${people.map((g) => `${g.name ?? g.email} <${g.email}> (${g.response ?? "no answer"})`).join(", ")}`
          : "",
        ev.selfOrganizer
          ? ""
          : `Organizer: ${ev.organizer}. Your answer: ${ev.selfResponse ?? "none"}.`,
        ev.meetUrl ? `Video: ${ev.meetUrl}` : "",
        ev.taskId ? `A time block for task ${ev.taskId}.` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return describeRow(row, extra, tail);
    },
    async prep(entityId, ctx) {
      const row = await liveEntity(ctx.db, entityId, "prep");
      return row ? describeRow(row) : null;
    },
  },
  routines: [prepRoutine, blockRoutine],
  actions: [
    defineAction({
      name: "calendar.events",
      description:
        "Events between two times (default: today and tomorrow), earliest first, with guests and ids.",
      input: z.object({
        from: isoDateTime.optional(),
        to: isoDateTime.optional(),
        includeCancelled: z.boolean().default(false),
      }),
      risk: "read",
      async handler(i, ctx) {
        const from = i.from ? new Date(i.from) : ctx.now;
        const to = i.to ? new Date(i.to) : new Date(from.getTime() + 2 * DAY_MS);
        const rows = await ctx.tx
          .select({ e: entity, r: calendarEvent })
          .from(calendarEvent)
          .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
          .innerJoin(calendar, eq(calendar.id, calendarEvent.calendarId))
          .where(
            and(
              isNull(entity.deletedAt),
              eq(calendar.selected, true),
              lt(calendarEvent.startsAt, to),
              gt(calendarEvent.endsAt, from),
              ...(i.includeCancelled ? [] : [ne(calendarEvent.status, "cancelled")]),
            ),
          )
          .orderBy(asc(calendarEvent.startsAt))
          .limit(500);
        return rows.map((x) => toEventView(x.e, x.r));
      },
    }),
    defineAction({
      name: "calendar.get",
      description: "One event in full.",
      input: z.object({ id }),
      risk: "read",
      handler: (i, ctx) => loadEvent(ctx.tx, i.id),
    }),
    defineAction({
      name: "calendar.free_time",
      description:
        "Free slots in the owner's working hours (never evenings or weekends) of at least `minutes`, from now or `from`, over `days` days.",
      input: z.object({
        minutes: z.number().int().min(15).max(600).default(30),
        from: isoDateTime.optional(),
        days: z.number().int().min(1).max(30).default(5),
      }),
      risk: "read",
      async handler(i, ctx) {
        const rules = await getSetting(ctx.tx, "owner.dayRules");
        const from = i.from ? new Date(i.from) : ctx.now;
        const slots = await freeSlots(
          ctx.tx,
          from,
          new Date(from.getTime() + i.days * DAY_MS),
          i.minutes,
          rules,
        );
        return slots.slice(0, 40);
      },
    }),
    defineAction({
      name: "calendar.calendars",
      description: "Connected Google accounts and their calendars, and which ones Hearth syncs.",
      input: z.object({}),
      risk: "read",
      async handler(_i, ctx) {
        const google = ctx.service<GoogleClient>(GOOGLE_SERVICE);
        const accounts = await ctx.tx
          .select({
            email: googleAccount.email,
            scopes: googleAccount.scopes,
            status: googleAccount.status,
            lastError: googleAccount.lastError,
            connectedAt: googleAccount.connectedAt,
          })
          .from(googleAccount);
        const calendars = await ctx.tx.select().from(calendar).orderBy(asc(calendar.title));
        return { configured: google.configured, accounts, calendars };
      },
    }),
    defineAction({
      name: "calendar.choose",
      description: "Turn syncing on or off for one calendar.",
      input: z.object({ id: z.string().min(1), selected: z.boolean() }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        await ctx.tx.update(calendar).set({ selected: i.selected }).where(eq(calendar.id, i.id));
        return { ok: true };
      },
    }),
    defineAction({
      name: "calendar.sync",
      description: "Pull the latest from Google Calendar now.",
      input: z.object({}),
      risk: "internal",
      callers: ["owner", "system", "integration"],
      handler: (_i, ctx) => syncCalendars(ctx),
    }),
    defineAction({
      name: "google.disconnect",
      description: "Forget a Google account: its tokens, calendars and mail leave Hearth.",
      input: z.object({ email: z.string().email() }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const email = i.email.toLowerCase();
        const cals = await ctx.tx
          .select({ id: calendar.id })
          .from(calendar)
          .where(eq(calendar.account, email));
        if (cals.length) {
          const events = ctx.tx
            .select({ id: calendarEvent.entityId })
            .from(calendarEvent)
            .where(
              inArray(
                calendarEvent.calendarId,
                cals.map((c) => c.id),
              ),
            );
          await ctx.tx.delete(entity).where(inArray(entity.id, events));
        }
        // Its mail too: messages, conversations, drafts and the account (raw copies stay on disk).
        const mailId = `gmail:${email}`;
        for (const table of [mailMessage, mailThread, mailDraft] as const)
          await ctx.tx
            .delete(entity)
            .where(
              inArray(
                entity.id,
                ctx.tx
                  .select({ id: table.entityId })
                  .from(table)
                  .where(eq(table.accountId, mailId)),
              ),
            );
        await ctx.tx.delete(mailAccount).where(eq(mailAccount.id, mailId));
        const gone = await ctx.tx
          .delete(googleAccount)
          .where(eq(googleAccount.email, email))
          .returning({ email: googleAccount.email, token: googleAccount.refreshToken });
        let google: GoogleClient | null = null;
        try {
          google = ctx.service<GoogleClient>(GOOGLE_SERVICE);
        } catch {}
        for (const g of gone) await google?.revoke(g.token, g.email);
        return { removed: gone.length };
      },
    }),
    ...calendarWriteActions,
    blockAction,
    prepPublish,
  ],
  reflexes: [conflicts, syncFailed, noRoom, blockReflex],
  async digest(ctx): Promise<DigestItem[]> {
    const rules = await getSetting(ctx.db, "owner.dayRules");
    const today = localDate(ctx.now, rules.timeZone);
    const rows = await ctx.db
      .select({ e: entity, r: calendarEvent })
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
      .innerJoin(calendar, eq(calendar.id, calendarEvent.calendarId))
      .where(
        and(
          eq(calendar.selected, true),
          ne(calendarEvent.status, "cancelled"),
          gte(calendarEvent.endsAt, ctx.now),
          lt(calendarEvent.startsAt, new Date(ctx.now.getTime() + DAY_MS)),
        ),
      )
      .orderBy(asc(calendarEvent.startsAt))
      .limit(30);
    const items: DigestItem[] = rows
      .map((x) => toEventView(x.e, x.r))
      .filter((v) => localDate(v.startsAt, rules.timeZone) <= today || v.allDay)
      .filter((v) => v.selfResponse !== "declined")
      .map((v) => ({
        bucket: "today" as const,
        text: v.allDay
          ? `${v.title} (all day)`
          : `${formatTime(v.startsAt, rules.timeZone)} ${v.taskId ? "focus block: " : ""}${v.title}${
              v.selfResponse === "needsAction" ? " (not answered yet)" : ""
            }`,
        entityId: v.id,
        // Someone else's invitation is titled by them, so it's outside content (D58).
        outside: !v.selfOrganizer,
      }));
    const preps = await ctx.db
      .select({
        id: entity.id,
        title: entity.title,
        createdBy: entity.createdBy,
        outside: entity.outside,
      })
      .from(entity)
      .where(
        and(eq(entity.type, "prep"), isNull(entity.deletedAt), gte(entity.createdAt, ctx.since)),
      )
      .limit(20);
    for (const p of preps)
      items.push({ bucket: "prepared", text: p.title, entityId: p.id, outside: isOutside(p) });
    return items;
  },
});
