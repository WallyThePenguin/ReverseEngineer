import {
  isClosedStatus,
  parseTaskNumber,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskStatus,
} from "@hearth/core";
import { entity, task } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  createEntity,
  defineAction,
  notFound,
  touchEntity,
  updateEntity,
} from "@hearth/kernel";
import { and, asc, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { body, id, isoDateTime, title } from "../shared.ts";
import { loadTask, type TaskView, toTaskView } from "./view.ts";

const fields = {
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: isoDateTime.nullable().optional(),
  dueIsDate: z.boolean().optional(),
  estimateMinutes: z.number().int().positive().max(100_000).nullable().optional(),
  assignee: z.enum(["owner", "jarvis"]).nullable().optional(),
  projectId: id.nullable().optional(),
};

type Fields = { [K in keyof typeof fields]?: z.output<(typeof fields)[K]> };

function emitFieldEvents(ctx: ActionContext, before: TaskView | null, after: TaskView): string[] {
  const changed: string[] = [];
  const base = { number: after.number, title: after.title };
  if ((before?.status ?? null) !== after.status && before) {
    changed.push("status");
    ctx.emit({
      kind: "task.status_changed",
      entityId: after.id,
      payload: { ...base, from: before.status, to: after.status },
    });
  }
  if ((before?.assignee ?? null) !== after.assignee) {
    if (before) changed.push("assignee");
    if (after.assignee || before?.assignee) {
      ctx.emit({
        kind: "task.assigned",
        entityId: after.id,
        payload: { ...base, from: before?.assignee ?? null, to: after.assignee },
      });
    }
  }
  const beforeDue = before?.dueAt?.toISOString() ?? null;
  const afterDue = after.dueAt?.toISOString() ?? null;
  if (beforeDue !== afterDue) {
    if (before) changed.push("dueAt");
    ctx.emit({
      kind: "task.due_changed",
      entityId: after.id,
      payload: { ...base, from: beforeDue, to: afterDue },
    });
  }
  if (before && before.priority !== after.priority) changed.push("priority");
  if (before && before.estimateMinutes !== after.estimateMinutes) changed.push("estimateMinutes");
  if (before && before.projectId !== after.projectId) changed.push("projectId");
  return changed;
}

function completedAtFor(
  status: TaskStatus | undefined,
  previous: Date | null,
  now: Date,
): Date | null | undefined {
  if (status === undefined) return undefined;
  if (status === "completed") return previous ?? now;
  return null;
}

export const createTask = defineAction({
  name: "task.create",
  description:
    "Create a task. Optional: status, priority, dueAt (ISO; set dueIsDate for a whole-day due date), estimateMinutes, assignee (owner or jarvis), parentId for a subtask.",
  input: z.object({ title, body: body.optional(), parentId: id.optional(), ...fields }),
  risk: "internal",
  async handler(i, ctx): Promise<TaskView> {
    const e = await createEntity(ctx, {
      type: "task",
      title: i.title,
      body: i.body ?? "",
      parentId: i.parentId ?? null,
    });
    const status = i.status ?? "not_started";
    const [t] = await ctx.tx
      .insert(task)
      .values({
        entityId: e.id,
        status,
        priority: i.priority ?? "none",
        dueAt: i.dueAt ? new Date(i.dueAt) : null,
        dueIsDate: i.dueIsDate ?? false,
        estimateMinutes: i.estimateMinutes ?? null,
        assignee: i.assignee ?? null,
        projectId: i.projectId ?? null,
        completedAt: status === "completed" ? ctx.now : null,
      })
      .returning();
    const view = toTaskView(e, t!);
    emitFieldEvents(ctx, null, view);
    return view;
  },
});

export const updateTask = defineAction({
  name: "task.update",
  description:
    "Change a task: title, body, status (not_started, in_progress, in_review, completed, canceled), priority, dueAt, estimateMinutes, assignee.",
  input: z.object({
    id,
    title: title.optional(),
    body: body.optional(),
    revision: z.number().int().optional(),
    ...fields,
  }),
  risk: "internal",
  async handler(i, ctx): Promise<TaskView> {
    const before = await loadTask(ctx.tx, { id: i.id });
    if (!before) throw notFound("Task");
    if (i.title !== undefined || i.body !== undefined) {
      await updateEntity(
        ctx,
        i.id,
        { title: i.title, body: i.body },
        { expectedRevision: i.revision, type: "task" },
      );
    } else if (i.revision !== undefined && i.revision !== before.revision) {
      throw new ActionError(
        "conflict",
        "This task changed since you opened it. Reload and try again.",
      );
    }
    const patch: Partial<typeof task.$inferInsert> = {};
    const f: Fields = i;
    if (f.status !== undefined) patch.status = f.status;
    if (f.priority !== undefined) patch.priority = f.priority;
    if (f.dueAt !== undefined) patch.dueAt = f.dueAt ? new Date(f.dueAt) : null;
    if (f.dueIsDate !== undefined) patch.dueIsDate = f.dueIsDate;
    if (f.estimateMinutes !== undefined) patch.estimateMinutes = f.estimateMinutes;
    if (f.assignee !== undefined) patch.assignee = f.assignee;
    if (f.projectId !== undefined) patch.projectId = f.projectId;
    const completedAt = completedAtFor(f.status, before.completedAt, ctx.now);
    if (completedAt !== undefined) patch.completedAt = completedAt;
    if (Object.keys(patch).length > 0)
      await ctx.tx.update(task).set(patch).where(eq(task.entityId, i.id));
    const after = (await loadTask(ctx.tx, { id: i.id }))!;
    const changed = emitFieldEvents(ctx, before, after);
    if (changed.length > 0 && i.title === undefined && i.body === undefined)
      await touchEntity(ctx, i.id, changed);
    return (await loadTask(ctx.tx, { id: i.id }))!;
  },
});

export const getTask = defineAction({
  name: "task.get",
  description: "Get a task by id or by its key, such as T-12.",
  input: z
    .object({ id: id.optional(), key: z.string().optional() })
    .refine((v) => v.id || v.key, "Pass id or key"),
  risk: "read",
  async handler(i, ctx) {
    const number = i.key ? parseTaskNumber(i.key) : null;
    const view = await loadTask(ctx.tx, i.id ? { id: i.id } : { number: number ?? -1 });
    if (!view) throw notFound("Task");
    return view;
  },
});

export const listTasks = defineAction({
  name: "task.list",
  description:
    "List tasks. By default only open ones (not completed or canceled). Filter by status, assignee, project, parent task (parentId lists its subtasks), or due before a time.",
  input: z.object({
    status: z.array(z.enum(TASK_STATUSES)).optional(),
    assignee: z.enum(["owner", "jarvis", "nobody"]).optional(),
    projectId: id.optional(),
    parentId: id.optional(),
    dueBefore: isoDateTime.optional(),
    includeClosed: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  risk: "read",
  async handler(i, ctx) {
    const rows = await ctx.tx
      .select()
      .from(task)
      .innerJoin(entity, eq(entity.id, task.entityId))
      .where(
        and(
          isNull(entity.deletedAt),
          i.status?.length ? inArray(task.status, i.status) : undefined,
          !i.status && !i.includeClosed
            ? notInArray(task.status, ["completed", "canceled"])
            : undefined,
          i.assignee === "nobody"
            ? isNull(task.assignee)
            : i.assignee
              ? eq(task.assignee, i.assignee)
              : undefined,
          i.projectId ? eq(task.projectId, i.projectId) : undefined,
          i.parentId ? eq(entity.parentId, i.parentId) : undefined,
          i.dueBefore ? lte(task.dueAt, new Date(i.dueBefore)) : undefined,
        ),
      )
      .orderBy(sql`${task.dueAt} ASC NULLS LAST`, asc(task.number))
      .limit(i.limit);
    return rows.map((r) => toTaskView(r.entity, r.task));
  },
});

export const TASK_ACTIONS = [createTask, updateTask, getTask, listTasks];
export { isClosedStatus };
