// Tasks: Not Started to Completed, T-123 keys, due dates and assignees (you or Jarvis).
import {
  formatDateTime,
  formatTaskNumber,
  localDate,
  startOfLocalDay,
  TASK_STATUS_LABELS,
} from "@hearth/core";
import { entity, task } from "@hearth/db";
import { type DigestItem, defineModule, getSetting } from "@hearth/kernel";
import { and, asc, eq, gte, isNull, lt, notInArray, or } from "drizzle-orm";
import { describeRow, isOutside, preview } from "../shared.ts";
import { TASK_ACTIONS } from "./actions.ts";
import { TASK_REFLEXES } from "./reflexes.ts";
import { loadTask, toTaskView } from "./view.ts";

const OPEN = notInArray(task.status, ["completed", "canceled"]);
const STALLED_DAYS = 5;

export const tasksModule = defineModule({
  name: "tasks",
  description:
    "Tasks with status, priority, due dates and an assignee. Pip works tasks assigned to it (assignee jarvis).",
  entityTypes: ["task"],
  events: [
    { kind: "task.status_changed", description: "A task moved. Payload: number, title, from, to." },
    {
      kind: "task.assigned",
      description:
        "A task's assignee changed. Payload: number, title, from, to (owner, jarvis or null).",
    },
    {
      kind: "task.due_changed",
      description: "A task's due time changed. Payload: number, title, from, to (ISO or null).",
    },
  ],
  actions: TASK_ACTIONS,
  reflexes: TASK_REFLEXES,
  knowledge: {
    async task(entityId, ctx) {
      const t = await loadTask(ctx.db, { id: entityId });
      if (!t) return null;
      const e = (await ctx.db.select().from(entity).where(eq(entity.id, entityId)))[0]!;
      // Dates and times in the owner's own time zone, as everywhere else Jarvis reads them.
      const { timeZone } = await getSetting(ctx.db, "owner.dayRules");
      const extra = [
        t.key,
        TASK_STATUS_LABELS[t.status],
        `priority ${t.priority}`,
        t.dueAt
          ? `due ${t.dueIsDate ? localDate(t.dueAt, timeZone) : formatDateTime(t.dueAt, timeZone)}`
          : "no due date",
        `assignee ${t.assignee ?? "nobody"}`,
      ];
      if (t.estimateMinutes) extra.push(`estimate ${t.estimateMinutes} min`);
      const kids = await ctx.db
        .select()
        .from(entity)
        .where(and(eq(entity.parentId, entityId), isNull(entity.deletedAt)))
        .orderBy(asc(entity.createdAt));
      const subtasks = kids.filter((k) => k.type === "task").map((k) => `- ${k.title} (${k.id})`);
      const thread = kids
        .filter((k) => k.type === "comment")
        .slice(-10)
        .map(
          (k) =>
            `- ${k.createdBy} at ${formatDateTime(k.createdAt, timeZone)}: ${preview(k.body, 600)}`,
        );
      const tail = [
        subtasks.length ? `## Subtasks\n${subtasks.join("\n")}` : "",
        thread.length ? `## Thread (latest ${thread.length})\n${thread.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return describeRow(e, extra, tail);
    },
  },
  async digest(ctx): Promise<DigestItem[]> {
    const rules = await getSetting(ctx.db, "owner.dayRules");
    const dayStart = startOfLocalDay(ctx.now, rules.timeZone);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const items: DigestItem[] = [];
    const rows = await ctx.db
      .select()
      .from(task)
      .innerJoin(entity, eq(entity.id, task.entityId))
      .where(
        and(
          isNull(entity.deletedAt),
          OPEN,
          or(isNull(task.assignee), eq(task.assignee, "owner")),
          lt(task.dueAt, dayEnd),
        ),
      )
      .orderBy(asc(task.dueAt));
    for (const r of rows) {
      const t = toTaskView(r.entity, r.task);
      const overdue = t.dueAt! < dayStart || (!t.dueIsDate && t.dueAt! < ctx.now);
      items.push({
        bucket: "today",
        text: `${overdue ? "Overdue" : "Due today"}: ${t.key} ${t.title}${t.dueIsDate ? "" : ` (${formatDateTime(t.dueAt!)})`}`,
        entityId: t.id,
        outside: isOutside(r.entity),
      });
    }
    const handled = await ctx.db
      .select()
      .from(task)
      .innerJoin(entity, eq(entity.id, task.entityId))
      .where(
        and(
          eq(task.assignee, "jarvis"),
          gte(entity.updatedAt, ctx.since),
          isNull(entity.deletedAt),
        ),
      );
    for (const r of handled) {
      const t = toTaskView(r.entity, r.task);
      if (t.status === "in_review" || t.status === "completed") {
        items.push({
          bucket: "handled",
          text: `${t.key} ${t.title} is ${TASK_STATUS_LABELS[t.status]}`,
          entityId: t.id,
          outside: isOutside(r.entity),
        });
      }
    }
    const stalledBefore = new Date(ctx.now.getTime() - STALLED_DAYS * 24 * 3600_000);
    const stalled = await ctx.db
      .select()
      .from(task)
      .innerJoin(entity, eq(entity.id, task.entityId))
      .where(
        and(
          eq(task.status, "in_progress"),
          lt(entity.updatedAt, stalledBefore),
          isNull(entity.deletedAt),
        ),
      );
    for (const r of stalled) {
      items.push({
        bucket: "fyi",
        text: `${formatTaskNumber(r.task.number)} ${r.entity.title} has been In Progress with no change for ${STALLED_DAYS}+ days`,
        entityId: r.entity.id,
        outside: isOutside(r.entity),
      });
    }
    return items;
  },
});

export { loadTask, type TaskView } from "./view.ts";
