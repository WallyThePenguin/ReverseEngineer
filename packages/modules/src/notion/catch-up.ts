// Catching up on tickets whose news didn't land (Connections-16): a ticket can be yours with no
// task, or done with its task still open, when making or closing the task failed, or when
// notion.to_tasks didn't run (it used to stop while Jarvis was paused). Each round compares the
// tickets with their tasks and tells their news again, so notion.to_tasks puts them right.
import { entity, link, notionTask, task } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, eq, inArray, isNull } from "drizzle-orm";

const CLOSED = ["completed", "canceled"];

type Ticket = typeof notionTask.$inferSelect & { title: string };

/**
 * Tells the news again of each of the board's tickets out of step with its task, leaving out the
 * ones told this round. A task you put in the trash or closed yourself is yours to keep: an open
 * ticket with any task at all is never given another. Returns how many were told, by kind.
 */
export async function catchUp(
  ctx: ActionContext,
  sourceId: string,
  told: ReadonlySet<string>,
  payloadOf: (t: Ticket) => Record<string, unknown>,
): Promise<{ assigned: number; done: number; unassigned: number }> {
  const out = { assigned: 0, done: 0, unassigned: 0 };
  const tickets = (
    await ctx.tx
      .select({ row: notionTask, title: entity.title })
      .from(notionTask)
      .innerJoin(entity, eq(entity.id, notionTask.entityId))
      .where(and(eq(notionTask.sourceId, sourceId), isNull(entity.deletedAt)))
  )
    .map((r) => ({ ...r.row, title: r.title }))
    .filter((t) => !told.has(t.entityId));
  if (tickets.length === 0) return out;
  const tasks = await ctx.tx
    .select({ ticket: link.toId, status: task.status, gone: entity.deletedAt })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .innerJoin(task, eq(task.entityId, entity.id))
    .where(
      inArray(
        link.toId,
        tickets.map((t) => t.entityId),
      ),
    );
  for (const t of tickets) {
    const its = tasks.filter((k) => k.ticket === t.entityId);
    const open = its.some((k) => !k.gone && !CLOSED.includes(k.status));
    const kind =
      t.assigned && !t.done && its.length === 0
        ? "notion.task_assigned"
        : t.done && open
          ? "notion.task_done"
          : !t.assigned && !t.done && open
            ? "notion.task_unassigned"
            : null;
    if (!kind) continue;
    ctx.emit({ kind, entityId: t.entityId, payload: { ...payloadOf(t), caughtUp: true } });
    if (kind === "notion.task_assigned") out.assigned++;
    else if (kind === "notion.task_done") out.done++;
    else out.unassigned++;
  }
  return out;
}
