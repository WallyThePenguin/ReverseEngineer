import { formatTaskNumber } from "@hearth/core";
import { type DbOrTx, entity, task } from "@hearth/db";
import { and, eq, isNull } from "drizzle-orm";

export type TaskRow = typeof task.$inferSelect;
export type EntityRowT = typeof entity.$inferSelect;

export interface TaskView {
  id: string;
  number: number;
  key: string;
  title: string;
  body: string | null;
  status: TaskRow["status"];
  priority: TaskRow["priority"];
  dueAt: Date | null;
  dueIsDate: boolean;
  estimateMinutes: number | null;
  assignee: string | null;
  projectId: string | null;
  parentId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  revision: number;
}

export function toTaskView(e: EntityRowT, t: TaskRow): TaskView {
  return {
    id: e.id,
    number: t.number,
    key: formatTaskNumber(t.number),
    title: e.title,
    body: e.body,
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt,
    dueIsDate: t.dueIsDate,
    estimateMinutes: t.estimateMinutes,
    assignee: t.assignee,
    projectId: t.projectId,
    parentId: e.parentId,
    completedAt: t.completedAt,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    createdBy: e.createdBy,
    revision: e.revision,
  };
}

export async function loadTask(
  db: DbOrTx,
  where: { id?: string; number?: number },
): Promise<TaskView | null> {
  const cond = where.id ? eq(task.entityId, where.id) : eq(task.number, where.number ?? -1);
  const [row] = await db
    .select()
    .from(task)
    .innerJoin(entity, eq(entity.id, task.entityId))
    .where(and(cond, isNull(entity.deletedAt)));
  return row ? toTaskView(row.entity, row.task) : null;
}
