// Writing to the inbox. Interrupts go through the interrupt budget; everything else just lands.
import { decideInterrupt, startOfLocalDay } from "@hearth/core";
import { notification } from "@hearth/db";
import { and, count, gte, isNotNull } from "drizzle-orm";
import { newId } from "./ids.ts";
import { getSetting } from "./settings.ts";
import type { ActionContext, NewNotification } from "./types.ts";

export type NotificationRow = typeof notification.$inferSelect;

type WriteContext = Pick<ActionContext, "tx" | "now" | "caller" | "emit">;

/**
 * Creates an inbox item. With a dedupe key, a second call for the same thing is a no-op and
 * returns null. Interrupts are delivered or held according to the interrupt budget.
 */
export async function createNotification(
  ctx: WriteContext,
  input: NewNotification,
  sourceEventSeq?: number,
): Promise<NotificationRow | null> {
  const urgency = input.urgency ?? "normal";
  let deliveredAt: Date | null = null;
  let deferredReason: string | null = null;

  if (urgency === "interrupt") {
    const rules = await getSetting(ctx.tx, "owner.dayRules");
    const maxPerDay = await getSetting(ctx.tx, "owner.maxInterruptsPerDay");
    const since = startOfLocalDay(ctx.now, rules.timeZone);
    const [row] = await ctx.tx
      .select({ n: count() })
      .from(notification)
      .where(and(isNotNull(notification.deliveredAt), gte(notification.deliveredAt, since)));
    const decision = decideInterrupt(
      { now: ctx.now, deliveredToday: row?.n ?? 0, deadline: input.deadline ?? null },
      { maxPerDay, rules },
    );
    if (decision.deliver) deliveredAt = ctx.now;
    else deferredReason = decision.reason;
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
    },
  });
  return created;
}
