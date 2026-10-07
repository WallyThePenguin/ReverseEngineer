// The inbox: everything that needs you, in one keyboard-driven list (PLAN.md section 4).
import { approval, entity, notification, type Tx } from "@hearth/db";
import {
  ActionError,
  createNotification,
  type DigestItem,
  defineAction,
  defineModule,
  interruptDecision,
} from "@hearth/kernel";
import { and, count, desc, eq, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { id, isoDateTime } from "../shared.ts";
import { reminderActions, ringReminder } from "./reminders.ts";

const live = (now: Date) =>
  and(
    ne(notification.state, "done"),
    or(isNull(notification.snoozedUntil), lte(notification.snoozedUntil, now)),
  );

/** Not an approval's card while that approval waits for a yes or no, or is being done: such a
 * card leaves the inbox only by deciding it (D58), so it can't be put away and forgotten. */
const notAwaitingDecision = (tx: Tx) =>
  notExists(
    tx
      .select({ id: approval.id })
      .from(approval)
      .where(
        and(
          eq(approval.id, notification.approvalId),
          inArray(approval.status, ["pending", "executing"]),
        ),
      ),
  );
const NEEDS_DECISION = "This one needs a yes or a no first.";

export const inboxModule = defineModule({
  name: "inbox",
  description: "One list of everything that needs you, split into Signal and Noise.",
  entityTypes: [],
  events: [
    {
      kind: "notification.delivered",
      description:
        "An interrupt held for quiet hours went out. Payload: notificationId, kind, title, urgency, delivered.",
    },
  ],
  kernelEvents: ["notification.created", "notification.updated"],
  knowledge: {},
  actions: [
    defineAction({
      name: "inbox.list",
      description: "List inbox items. By default the live ones: not done and not snoozed.",
      input: z.object({
        view: z.enum(["live", "snoozed", "done"]).default("live"),
        lane: z.enum(["signal", "noise"]).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
      risk: "read",
      async handler(i, ctx) {
        const where =
          i.view === "live"
            ? live(ctx.now)
            : i.view === "done"
              ? eq(notification.state, "done")
              : and(ne(notification.state, "done"), sql`${notification.snoozedUntil} > ${ctx.now}`);
        return ctx.tx
          .select({
            notification,
            entityTitle: entity.title,
            entityType: entity.type,
            approvalStatus: approval.status,
          })
          .from(notification)
          .leftJoin(entity, eq(entity.id, notification.entityId))
          .leftJoin(approval, eq(approval.id, notification.approvalId))
          .where(and(where, i.lane ? eq(notification.lane, i.lane) : undefined))
          .orderBy(desc(notification.createdAt))
          .limit(i.limit);
      },
    }),
    defineAction({
      name: "inbox.mark",
      description:
        "Mark inbox items unseen, seen or done. An approval's card is done once it's decided.",
      input: z.object({
        ids: z.array(id).min(1).max(500),
        state: z.enum(["unseen", "seen", "done"]),
      }),
      risk: "internal",
      async handler(i, ctx) {
        const rows = await ctx.tx
          .update(notification)
          .set({ state: i.state, updatedAt: ctx.now })
          .where(
            and(
              inArray(notification.id, i.ids),
              ne(notification.state, i.state),
              i.state === "done" ? notAwaitingDecision(ctx.tx) : undefined,
            ),
          )
          .returning({ id: notification.id, entityId: notification.entityId });
        for (const r of rows) {
          ctx.emit({
            kind: "notification.updated",
            entityId: r.entityId,
            payload: { notificationId: r.id, state: i.state },
          });
        }
        return { updated: rows.length };
      },
    }),
    defineAction({
      name: "inbox.snooze",
      description: "Hide an inbox item until a time; it comes back as unseen then.",
      input: z.object({ id, until: isoDateTime }),
      risk: "internal",
      async handler(i, ctx) {
        const until = new Date(i.until);
        const [r] = await ctx.tx
          .update(notification)
          .set({ snoozedUntil: until, state: "seen", updatedAt: ctx.now })
          .where(and(eq(notification.id, i.id), notAwaitingDecision(ctx.tx)))
          .returning({ id: notification.id, entityId: notification.entityId });
        if (!r) {
          const [n] = await ctx.tx
            .select({ id: notification.id })
            .from(notification)
            .where(eq(notification.id, i.id));
          if (n) throw new ActionError("conflict", NEEDS_DECISION);
          return { snoozed: false };
        }
        ctx.emit({
          kind: "notification.updated",
          entityId: r.entityId,
          payload: { notificationId: r.id, state: "seen", snoozedUntil: until.toISOString() },
        });
        return { snoozed: true };
      },
    }),
    defineAction({
      name: "inbox.wake",
      description: "Bring a snoozed item back to the top of the inbox.",
      input: z.object({ id }),
      risk: "internal",
      async handler(i, ctx) {
        const [r] = await ctx.tx
          .update(notification)
          .set({ snoozedUntil: null, state: "unseen", updatedAt: ctx.now })
          .where(and(eq(notification.id, i.id), ne(notification.state, "done")))
          .returning({ id: notification.id, entityId: notification.entityId });
        if (r)
          ctx.emit({
            kind: "notification.updated",
            entityId: r.entityId,
            payload: { notificationId: r.id, state: "unseen" },
          });
        return { woke: Boolean(r) };
      },
    }),
    defineAction({
      name: "inbox.notify",
      description:
        "Put something in the owner's inbox. Use urgency interrupt only for things that can't wait (it is rationed); otherwise normal.",
      input: z.object({
        title: z.string().trim().min(1).max(300),
        body: z.string().max(5000).optional(),
        entityId: id.optional(),
        urgency: z.enum(["interrupt", "normal", "quiet"]).default("normal"),
        deadline: isoDateTime.optional(),
        dedupeKey: z.string().max(300).optional(),
        kind: z.string().max(60).default("note"),
      }),
      risk: "internal",
      async handler(i, ctx) {
        const created = await createNotification(ctx, {
          kind: i.kind,
          title: i.title,
          body: i.body ?? null,
          entityId: i.entityId ?? null,
          urgency: i.urgency,
          deadline: i.deadline ? new Date(i.deadline) : null,
          dedupeKey: i.dedupeKey ?? null,
        });
        return created
          ? { id: created.id, delivered: created.deliveredAt !== null }
          : { duplicate: true };
      },
    }),
    defineAction({
      name: "inbox.deliver",
      description: "Send out an interrupt held for quiet hours, unless you've seen it since.",
      input: z.object({ id }),
      risk: "internal",
      callers: ["system"],
      async handler(i, ctx) {
        const [n] = await ctx.tx.select().from(notification).where(eq(notification.id, i.id));
        if (n?.urgency !== "interrupt" || n.deliveredAt || n.state !== "unseen")
          return { delivered: false };
        // Its deadline already had its say overnight; now it only needs a slot in the budget.
        const decision = await interruptDecision(ctx, null);
        if (!decision.deliver) {
          await ctx.tx
            .update(notification)
            .set({ deferredReason: decision.reason, updatedAt: ctx.now })
            .where(eq(notification.id, n.id));
          return { delivered: false };
        }
        // Read again under the lock: a second sender that waited on it finds it already sent.
        const [sent] = await ctx.tx
          .update(notification)
          .set({ deliveredAt: ctx.now, deferredReason: null, updatedAt: ctx.now })
          .where(
            and(
              eq(notification.id, n.id),
              isNull(notification.deliveredAt),
              eq(notification.state, "unseen"),
            ),
          )
          .returning({ id: notification.id });
        if (!sent) return { delivered: false };
        ctx.emit({
          kind: "notification.delivered",
          entityId: n.entityId,
          payload: {
            notificationId: n.id,
            kind: n.kind,
            title: n.title,
            urgency: n.urgency,
            delivered: true,
          },
        });
        return { delivered: true };
      },
    }),
    ...reminderActions,
  ],
  reflexes: [
    ringReminder,
    {
      name: "inbox.wake_snoozed",
      description: "Brings snoozed items back when their time comes.",
      mode: "always",
      on: ["notification.updated"],
      includeJarvisEvents: true,
      run(event) {
        const until = event.payload.snoozedUntil;
        if (typeof until !== "string") return [];
        const id = String(event.payload.notificationId);
        return [
          { kind: "check_later", key: id, at: new Date(until), payload: { notificationId: id } },
        ];
      },
      async onCheck(payload) {
        return [{ kind: "act", action: "inbox.wake", input: { id: payload.notificationId } }];
      },
    },
    {
      name: "inbox.deliver_held",
      description: "Sends an interrupt held overnight when quiet hours end (D54).",
      mode: "always",
      on: ["notification.created"],
      includeJarvisEvents: true,
      run(event) {
        const at = event.payload.retryAt;
        if (typeof at !== "string") return [];
        const id = String(event.payload.notificationId);
        return [
          { kind: "check_later", key: id, at: new Date(at), payload: { notificationId: id } },
        ];
      },
      async onCheck(payload) {
        return [{ kind: "act", action: "inbox.deliver", input: { id: payload.notificationId } }];
      },
    },
  ],
  async digest(ctx): Promise<DigestItem[]> {
    const [row] = await ctx.db
      .select({ n: count() })
      .from(notification)
      .where(and(live(ctx.now), eq(notification.state, "unseen"), eq(notification.lane, "signal")));
    const n = row?.n ?? 0;
    return n > 0
      ? [{ bucket: "fyi", text: `${n} unseen item${n === 1 ? "" : "s"} in the inbox` }]
      : [];
  },
});
