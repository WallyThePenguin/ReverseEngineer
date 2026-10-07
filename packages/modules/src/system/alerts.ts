// Hearth's own failures go to the inbox straight from the report that says so, in the same
// transaction. They used to go through a reflex, which only the Jarvis process runs, so with
// Jarvis stopped nothing else could tell you either. They're interrupts, so they reach your
// phone: inside the day's budget, and held through quiet hours until the morning (a backup that
// fails at 2 a.m. buzzes at breakfast, not at 2 a.m.).
import { localDate } from "@hearth/core";
import { notification } from "@hearth/db";
import {
  type ActionContext,
  createNotification,
  getSetting,
  interruptDecision,
} from "@hearth/kernel";
import { and, eq, ne, sql } from "drizzle-orm";

/** How a component is named in an alert; others go by their own name. */
const LABELS: Readonly<Record<string, string>> = {
  "sync.google": "Google sync",
  "sync.slack": "Slack sync",
  "sync.github": "GitHub sync",
  "sync.notion": "Notion sync",
  "sync.slack_bot": "Jarvis's Slack bot",
  worker: "Hearth's worker",
  server: "Hearth's server",
  disk: "Disk space",
  // The worker reports it failing when no backup has run for a day and a half.
  backup: "The nightly backup",
  schedules: "Scheduling",
  browser: "The Chrome link",
};

export const componentLabel = (component: string) => LABELS[component] ?? component;

type AlertContext = Pick<ActionContext, "tx" | "now" | "caller" | "emit">;

/** The owner's calendar day, so an evening failure and the next morning's are told apart. */
async function today(ctx: AlertContext) {
  const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
  return localDate(ctx.now, timeZone);
}

/**
 * Tells you a component started failing: one interrupt a day per component, so a flapping one
 * doesn't buzz all day. Jarvis raises its own, worded per outage (D54).
 *
 * Failing again after it was ok (`okAt`: when it last said so) opens the day's alert again,
 * closed or dismissed before then, saying what's wrong now, as a new item: with no second buzz
 * if it went out, and through the day's budget if it never did (held overnight, and closed
 * before the morning). One you closed while it was still failing stays as you left it.
 *
 * A new day's alert closes the ones before it: a slowdown that runs past midnight leaves one
 * open, not one a day.
 */
export async function alertFailing(
  ctx: AlertContext,
  component: string,
  detail: string,
  okAt?: string,
) {
  if (component === "jarvis") return;
  const dedupeKey = `failing:${component}:${await today(ctx)}`;
  const created = await createNotification(ctx, {
    kind: "system.alert",
    title: `${componentLabel(component)} is failing`,
    body: detail,
    urgency: "interrupt",
    dedupeKey,
  });
  if (created) return closeFailing(ctx, component, dedupeKey);
  if (!okAt) return;
  const [n] = await ctx.tx.select().from(notification).where(eq(notification.dedupeKey, dedupeKey));
  if (n?.state !== "done" || n.updatedAt > new Date(okAt)) return;
  const decision = n.deliveredAt ? null : await interruptDecision(ctx, null);
  const held = decision && !decision.deliver ? decision : null;
  await ctx.tx
    .update(notification)
    .set({
      state: "unseen",
      body: detail,
      snoozedUntil: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      ...(decision?.deliver ? { deliveredAt: ctx.now, deferredReason: null } : {}),
      ...(held ? { deferredReason: held.reason } : {}),
    })
    .where(eq(notification.id, n.id));
  ctx.emit({
    kind: "notification.updated",
    entityId: n.entityId,
    // A retryAt has the inbox send it then (inbox.deliver_held).
    payload: {
      notificationId: n.id,
      state: "unseen",
      ...(held?.retryAt ? { retryAt: held.retryAt.toISOString() } : {}),
    },
  });
  if (decision?.deliver)
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
}

/**
 * Closes a component's open "is failing" alerts, whatever day they're from: it's ok again, or
 * the one kept (today's) takes over.
 */
export async function closeFailing(ctx: AlertContext, component: string, kept?: string) {
  const rows = await ctx.tx
    .update(notification)
    .set({ state: "done", updatedAt: ctx.now })
    .where(
      and(
        ne(notification.state, "done"),
        sql`starts_with(${notification.dedupeKey}, ${`failing:${component}:`})`,
        kept ? ne(notification.dedupeKey, kept) : undefined,
      ),
    )
    .returning({ id: notification.id, entityId: notification.entityId });
  for (const r of rows)
    ctx.emit({
      kind: "notification.updated",
      entityId: r.entityId,
      payload: { notificationId: r.id, state: "done" },
    });
}

export async function alertBackupFailed(ctx: AlertContext, detail: string) {
  await createNotification(ctx, {
    kind: "system.alert",
    title: "Last night's backup failed",
    body: detail,
    urgency: "interrupt",
    dedupeKey: `backup_failed:${await today(ctx)}`,
  });
}
