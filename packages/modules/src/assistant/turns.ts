// Stop and Retry for Jarvis's turns (D54). Stop cancels what's waiting at once and asks the
// Jarvis process to stop what's running; Retry queues a failed or stopped turn again.
import { conversationLog, jarvisTurn, type Tx } from "@hearth/db";
import { ActionError, defineAction, newId, notFound, requireEntity } from "@hearth/kernel";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { appendLog } from "../chat/log.ts";
import { id } from "../shared.ts";

/** The Jarvis process listens here for turns to stop. */
export const CANCEL_CHANNEL = "hearth_jarvis_cancel";

/** Whether your last message came after anything Jarvis did in the conversation (and after any
 * Stop): Jarvis hasn't picked it up, so there's something for Stop to let go of. */
async function unseen(tx: Tx, conversationId: string): Promise<boolean> {
  const [log] = await tx
    .select({
      asked: sql<
        number | null
      >`max(${conversationLog.idx}) filter (where ${conversationLog.kind} = 'user_message')`,
      seen: sql<
        number | null
      >`max(${conversationLog.idx}) filter (where ${conversationLog.turnId} is not null or ${conversationLog.payload}->>'stopped' = 'true')`,
    })
    .from(conversationLog)
    .where(eq(conversationLog.conversationId, conversationId));
  return log?.asked != null && Number(log.asked) > Number(log.seen ?? -1);
}

/** A turn's context without the mark that it read outside content (packages/jarvis turn-end). */
function withoutRead(context: Record<string, unknown>): Record<string, unknown> {
  const { readOutside: _read, ...rest } = context;
  return rest;
}

export const turnActions = [
  defineAction({
    name: "jarvis.cancel_turn",
    description:
      "Stop Jarvis: the turn running in a conversation (or one turn), and any waiting to start.",
    input: z
      .object({ turnId: id.optional(), conversationId: id.optional() })
      .refine((i) => i.turnId || i.conversationId, "Say which turn or conversation to stop."),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const which = i.turnId
        ? eq(jarvisTurn.id, i.turnId)
        : eq(jarvisTurn.conversationId, i.conversationId!);
      // Not started yet: nothing to interrupt, so it's simply canceled.
      const waiting = await ctx.tx
        .update(jarvisTurn)
        .set({
          status: "canceled",
          errorKind: "canceled",
          cancelRequestedAt: ctx.now,
          finishedAt: ctx.now,
        })
        .where(and(which, eq(jarvisTurn.status, "queued")))
        .returning({ id: jarvisTurn.id, conversationId: jarvisTurn.conversationId });
      // Running: the Jarvis process stops it, told now and also by the row in case it missed that.
      const running = await ctx.tx
        .update(jarvisTurn)
        .set({ cancelRequestedAt: ctx.now })
        .where(and(which, eq(jarvisTurn.status, "running")))
        .returning({ id: jarvisTurn.id });
      for (const r of running)
        await ctx.tx.execute(sql`SELECT pg_notify(${CANCEL_CHANNEL}, ${r.id})`);
      // "stopped" also tells chat.reply not to answer a message Jarvis hasn't even seen yet
      // (it was down): stopping a conversation lets go of everything sent before.
      const stopped = async (conversationId: string, turnId: string | null) => {
        const payload = { text: "Stopped before Jarvis started.", stopped: true };
        const [idx] = await appendLog(
          ctx.tx,
          conversationId,
          [{ kind: "notice", payload, turnId }],
          ctx.now,
        );
        ctx.emit({
          kind: "conversation.appended",
          entityId: conversationId,
          payload: { conversationId, idx, kind: "notice", turnId },
        });
      };
      for (const w of waiting) if (w.conversationId) await stopped(w.conversationId, w.id);
      if (i.conversationId && waiting.length === 0 && running.length === 0) {
        await requireEntity(ctx.tx, i.conversationId, "conversation");
        if (await unseen(ctx.tx, i.conversationId)) await stopped(i.conversationId, null);
      }
      return { canceled: waiting.length, stopping: running.length };
    },
  }),
  defineAction({
    name: "jarvis.retry_turn",
    description: "Run a Jarvis turn that failed or was stopped again, as it was first asked.",
    input: z.object({ turnId: id }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const [t] = await ctx.tx.select().from(jarvisTurn).where(eq(jarvisTurn.id, i.turnId));
      if (!t) throw notFound("Turn");
      if (!["failed", "canceled", "skipped"].includes(t.status))
        throw new ActionError("conflict", "That turn didn't fail, so there's nothing to retry.");
      // Once is enough: a second press while the first retry waits or runs does nothing.
      const [pending] = await ctx.tx
        .select({ id: jarvisTurn.id })
        .from(jarvisTurn)
        .where(
          and(
            sql`${jarvisTurn.context}->>'retryOf' = ${t.id}`,
            inArray(jarvisTurn.status, ["queued", "running"]),
          ),
        );
      if (pending) return { turnId: pending.id };
      const turnId = newId();
      await ctx.tx.insert(jarvisTurn).values({
        id: turnId,
        trigger: t.trigger,
        // You asked for it, so it goes ahead of Jarvis's own work and isn't rationed.
        mode: "reactive",
        lane: t.lane,
        origin: t.origin,
        prompt: t.prompt,
        // Asked again now, so it isn't let go for being old.
        // What the failed one read isn't this one's: it says so again if it reads it again.
        context: { ...withoutRead(t.context), retryOf: t.id, askedAt: ctx.now.toISOString() },
        conversationId: t.conversationId,
        subjectId: t.subjectId,
        sourceEventSeq: t.sourceEventSeq,
        // A failed or skipped routine already published its plain version; a stopped one didn't.
        fallback: t.status === "canceled" ? t.fallback : null,
        queuedAt: ctx.now,
        notBefore: ctx.now,
      });
      // Shown at once, so the press visibly did something, and the turn waits like a message.
      if (t.conversationId) {
        const payload = { text: "Trying again.", retrying: true };
        const entry = { kind: "notice" as const, payload, turnId };
        const [idx] = await appendLog(ctx.tx, t.conversationId, [entry], ctx.now);
        ctx.emit({
          kind: "conversation.appended",
          entityId: t.conversationId,
          payload: { conversationId: t.conversationId, idx, kind: "notice", turnId },
        });
      }
      return { turnId };
    },
  }),
];
