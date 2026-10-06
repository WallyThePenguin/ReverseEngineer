// Your Notion tickets as Hearth tasks, kept in step without a model turn: a ticket newly yours
// becomes a task (or reopens the one it had), a done ticket closes its task, and a new title or
// due date carries over. One handed to someone else (or deleted) cancels its task. The task links
// to its ticket in its body; that link is how they find each other, so nothing is made twice.
import { atLocal, renderMention } from "@hearth/core";
import { type DbOrTx, entity, link, task } from "@hearth/db";
import { getSetting, type ReflexDef, type ReflexOutcome } from "@hearth/kernel";
import { and, eq, isNull } from "drizzle-orm";
import { liveEntity } from "../shared.ts";

const CLOSED = ["completed", "canceled"];

/** The task linked to this ticket, if one is still around. */
async function taskFor(db: DbOrTx, ticketId: string) {
  const [t] = await db
    .select({ id: entity.id, status: task.status })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .innerJoin(task, eq(task.entityId, entity.id))
    .where(and(eq(link.toId, ticketId), isNull(entity.deletedAt)))
    .limit(1);
  return t;
}

/** Notion's due date as a task's: a whole day is local midnight, marked as a day. */
async function dueOf(db: DbOrTx, p: Record<string, unknown>) {
  if (typeof p.dueAt !== "string") return { dueAt: null, dueIsDate: false };
  if (!p.dueIsDate) return { dueAt: p.dueAt, dueIsDate: false };
  const { timeZone } = await getSetting(db, "owner.dayRules");
  return { dueAt: atLocal(p.dueAt.slice(0, 10), 0, timeZone).toISOString(), dueIsDate: true };
}

export const notionToTasks: ReflexDef = {
  name: "notion.to_tasks",
  description:
    "Tickets assigned to you on your Notion board become Hearth tasks, closed when the ticket is done or goes to someone else, and kept in step with its title and due date.",
  mode: "proactive",
  on: ["notion.task_assigned", "notion.task_done", "notion.task_changed", "notion.task_unassigned"],
  async run(ev, ctx) {
    const ticketId = ev.entityId;
    const ticket = ticketId ? await liveEntity(ctx.db, ticketId, "notion_task") : undefined;
    if (!ticketId || !ticket) return [];
    const p = ev.payload;
    const mine = await taskFor(ctx.db, ticketId);
    const open = mine && !CLOSED.includes(mine.status);
    const act = (action: string, input: Record<string, unknown>): ReflexOutcome[] => [
      { kind: "act", action, input },
    ];
    if (ev.kind === "notion.task_done")
      return open ? act("task.update", { id: mine.id, status: "completed" }) : [];
    if (ev.kind === "notion.task_unassigned")
      return open ? act("task.update", { id: mine.id, status: "canceled" }) : [];
    if (ev.kind === "notion.task_assigned" && mine)
      return open ? [] : act("task.update", { id: mine.id, status: "not_started" });
    if (ev.kind === "notion.task_changed" && mine) {
      if (!open) return [];
      const changed = Array.isArray(p.changed) ? p.changed : [];
      return act("task.update", {
        id: mine.id,
        ...(changed.includes("title") ? { title: ticket.title } : {}),
        ...(changed.includes("due") ? await dueOf(ctx.db, p) : {}),
      });
    }
    // Newly yours, or changed before it ever had a task (it came while Jarvis was paused).
    const ref = renderMention({ type: "notion_task", id: ticketId, label: "Notion ticket" });
    const due = await dueOf(ctx.db, p);
    return act("task.create", {
      title: ticket.title,
      body: `From ${ref}.`,
      ...(due.dueAt ? due : {}),
    });
  },
};
