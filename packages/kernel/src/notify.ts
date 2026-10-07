// Writing to the inbox. Interrupts go through the interrupt budget; everything else just lands.
import { decideInterrupt, type InterruptDecision, PRINCIPAL, startOfLocalDay } from "@hearth/core";
import { notification } from "@hearth/db";
import { and, count, eq, gte, inArray, isNotNull, not, sql } from "drizzle-orm";
import { newId } from "./ids.ts";
import { getSetting } from "./settings.ts";
import type { ActionContext, Caller, NewNotification } from "./types.ts";

export type NotificationRow = typeof notification.$inferSelect;

type WriteContext = Pick<ActionContext, "tx" | "now" | "caller" | "emit">;

/**
 * Interrupts that don't use up the day's count when Hearth itself sends them: a meeting's
 * heads-up (modules/src/calendar/soon.ts), which breaks through anyway because the meeting is
 * about to start.
 */
const BUDGET_EXEMPT = ["calendar.meeting_soon"];

/**
 * Whether an interrupt may go out now. Hearth's processes count and deliver one at a time,
 * until commit, so two at once can't both take the last slot of the day (D54). Call it before
 * the transaction appends its events, as actions do: the event log's lock always comes second.
 */
export async function interruptDecision(
  ctx: Pick<ActionContext, "tx" | "now">,
  deadline: Date | null,
): Promise<InterruptDecision> {
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hearth_interrupt_budget'))`);
  const rules = await getSetting(ctx.tx, "owner.dayRules");
  const maxPerDay = await getSetting(ctx.tx, "owner.maxInterruptsPerDay");
  const since = startOfLocalDay(ctx.now, rules.timeZone);
  // A meeting's heads-up goes out whatever the count, so it doesn't use it up either: a day of
  // meetings mustn't hold back "backup failed". Only Hearth's own, by kind: other timed reminders
  // (a task due soon, whose date may have come from an email) still count.
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(notification)
    .where(
      and(
        isNotNull(notification.deliveredAt),
        gte(notification.deliveredAt, since),
        not(
          and(
            inArray(notification.kind, BUDGET_EXEMPT),
            eq(notification.createdBy, PRINCIPAL.system),
          )!,
        ),
      ),
    );
  return decideInterrupt(
    { now: ctx.now, deliveredToday: row?.n ?? 0, deadline },
    { maxPerDay, rules },
  );
}

/**
 * Whether a deadline can wake you or break through the day's budget (D54): only yours, Hearth's
 * own, or Jarvis's before it read outside content. One an outside agent, an integration or a
 * Slack member gave is shown, but waits like anything else (D62). It names who may, so a new
 * kind of caller may not until it's added here.
 */
export const vouchesForDeadline = (c: Pick<Caller, "kind" | "origin">) =>
  c.kind === "owner" || c.kind === "system" || (c.kind === "agent" && c.origin !== "untrusted");

/**
 * Creates an inbox item. With a dedupe key, a second call for the same thing is a no-op and
 * returns null. Interrupts are delivered or held according to the interrupt budget; one held
 * for quiet hours says when it may go out (retryAt), and the inbox delivers it then.
 */
export async function createNotification(
  ctx: WriteContext,
  input: NewNotification,
  sourceEventSeq?: number,
): Promise<NotificationRow | null> {
  const urgency = input.urgency ?? "normal";
  let deliveredAt: Date | null = null;
  let deferredReason: string | null = null;
  let retryAt: Date | null = null;

  if (urgency === "interrupt") {
    const deadline = vouchesForDeadline(ctx.caller) ? (input.deadline ?? null) : null;
    const decision = await interruptDecision(ctx, deadline);
    if (decision.deliver) deliveredAt = ctx.now;
    else {
      deferredReason = decision.reason;
      retryAt = decision.retryAt;
    }
  }

  const [created] = await ctx.tx
    .insert(notification)
    .values({
      id: newId(),
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      entityId: input.entityId ?? null,
      approvalId: input.approvalId ?? null,
      urgency,
      lane: input.lane ?? "signal",
      deadline: input.deadline ?? null,
      deliveredAt,
      deferredReason,
      dedupeKey: input.dedupeKey ?? null,
      sourceEventSeq: sourceEventSeq ?? null,
      createdBy: ctx.caller.principal,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing({ target: notification.dedupeKey })
    .returning();
  if (!created) return null;

  ctx.emit({
    kind: "notification.created",
    entityId: created.entityId,
    payload: {
      notificationId: created.id,
      kind: created.kind,
      title: created.title,
      urgency,
      delivered: deliveredAt !== null,
      deferredReason,
      ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
    },
  });
  return created;
}
