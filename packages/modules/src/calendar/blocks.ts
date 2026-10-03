// Time-blocking: a big task gets real time on your calendar, inside working hours, before it's
// due, never over a meeting and never in your evening. Done or dropped tasks give their future
// blocks back. No model turn; plain rules (PLAN.md section 6.2).
import { isClosedStatus } from "@hearth/core";
import { calendar, calendarEvent, type DbOrTx, entity, task } from "@hearth/db";
import {
  type ActionContext,
  defineAction,
  getSetting,
  type ReflexDef,
  type RoutineDef,
} from "@hearth/kernel";
import { and, asc, eq, gt, gte, isNull, lte, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { loadTask } from "../tasks/view.ts";
import { insertEvent, removeEvent } from "./actions.ts";
import { freeSlots } from "./free.ts";

const DAY_MS = 24 * 3600_000;
/** Blocks are at most this long; a bigger task gets several. */
export const MAX_BLOCK_MINUTES = 120;
const MIN_BLOCK_MINUTES = 30;
/** Space kept around meetings. */
const BUFFER_MINUTES = 10;
/** A task with no due date gets its time within this many days. */
const UNDATED_HORIZON_DAYS = 7;

async function futureBlocks(ctx: ActionContext, taskId: string) {
  return ctx.tx
    .select()
    .from(calendarEvent)
    .where(
      and(
        eq(calendarEvent.taskId, taskId),
        ne(calendarEvent.status, "cancelled"),
        gt(calendarEvent.endsAt, ctx.now),
      ),
    );
}

export interface BlockResult {
  created: number;
  removed: number;
  short: number;
}

/** Brings one task's blocks in line with the task. */
export async function blockTask(ctx: ActionContext, taskId: string): Promise<BlockResult> {
  const result: BlockResult = { created: 0, removed: 0, short: 0 };
  const [connected] = await ctx.tx.select().from(calendar).where(eq(calendar.canWrite, true));
  if (!connected) return result;
  const t = await loadTask(ctx.tx, { id: taskId });
  const existing = await futureBlocks(ctx, taskId);
  const min = await getSetting(ctx.tx, "calendar.blockMinMinutes");
  const wanted =
    t && !isClosedStatus(t.status) && t.assignee !== "jarvis" && (t.estimateMinutes ?? 0) >= min;
  if (!wanted) {
    for (const b of existing) {
      await removeEvent(ctx, b.entityId);
      result.removed++;
    }
    return result;
  }
  const deadline = t.dueAt ?? new Date(ctx.now.getTime() + UNDATED_HORIZON_DAYS * DAY_MS);
  // Blocks that now land after the due time move.
  for (const b of existing.filter((b) => b.endsAt > deadline)) {
    await removeEvent(ctx, b.entityId);
    result.removed++;
  }
  const kept = existing.filter((b) => b.endsAt <= deadline);
  // Time already spent in past blocks counts too.
  const past = await ctx.tx
    .select({ s: calendarEvent.startsAt, e: calendarEvent.endsAt })
    .from(calendarEvent)
    .where(
      and(
        eq(calendarEvent.taskId, taskId),
        ne(calendarEvent.status, "cancelled"),
        lte(calendarEvent.endsAt, ctx.now),
      ),
    );
  const minutes = (s: Date, e: Date) => (e.getTime() - s.getTime()) / 60_000;
  const have =
    past.reduce((n, p) => n + minutes(p.s, p.e), 0) +
    kept.reduce((n, k) => n + minutes(k.startsAt, k.endsAt), 0);
  let need = (t.estimateMinutes ?? 0) - have;
  if (need < MIN_BLOCK_MINUTES) return result;
  const rules = await getSetting(ctx.tx, "owner.dayRules");
  const start = new Date(ctx.now.getTime() + 30 * 60_000);
  if (deadline <= start) {
    result.short = need;
    return result;
  }
  const slots = await freeSlots(ctx.tx, start, deadline, MIN_BLOCK_MINUTES, rules, BUFFER_MINUTES);
  const q = 15 * 60_000;
  for (const slot of slots) {
    // Start on a quarter hour, and fill the slot before moving on to the next one.
    let s = new Date(Math.ceil(slot.start.getTime() / q) * q);
    while (need >= MIN_BLOCK_MINUTES) {
      const room = minutes(s, slot.end);
      const len = Math.min(need, MAX_BLOCK_MINUTES, Math.floor(room / 15) * 15);
      if (len < MIN_BLOCK_MINUTES) break;
      const end = new Date(s.getTime() + len * 60_000);
      await insertEvent(ctx, {
        title: `Focus: ${t.title}`,
        start: s.toISOString(),
        end: end.toISOString(),
        description: `Time for ${t.key}, put here by Hearth. Move or delete it freely.`,
        taskId,
      });
      result.created++;
      need -= len;
      s = end;
    }
  }
  if (need >= MIN_BLOCK_MINUTES) {
    result.short = need;
    ctx.emit({
      kind: "calendar.no_room",
      entityId: taskId,
      payload: { title: t.title, minutesShort: need, dueAt: t.dueAt?.toISOString() ?? null },
    });
  }
  return result;
}

export const blockAction = defineAction({
  name: "calendar.block_task",
  description:
    "Give a big task time on the owner's calendar before it's due (or remove its blocks if it's done). Uses free working hours only.",
  input: z.object({ taskId: id }),
  risk: "self_external",
  handler: (i, ctx) => blockTask(ctx, i.taskId),
});

/** The tasks that should have blocks: open, estimated big, not Jarvis's. */
async function bigTasks(ctx: { db: DbOrTx }, min: number) {
  const rows = await ctx.db
    .select({ id: task.entityId, estimate: task.estimateMinutes })
    .from(task)
    .innerJoin(entity, eq(entity.id, task.entityId))
    .where(
      and(
        isNull(entity.deletedAt),
        notInArray(task.status, ["completed", "canceled"]),
        gte(task.estimateMinutes, min),
      ),
    )
    .orderBy(asc(task.dueAt));
  return rows.map((r) => r.id);
}

export const blockRoutine: RoutineDef = {
  name: "calendar.time_blocks",
  description: "Each morning at 6:10 a.m., big tasks get time on your calendar before they're due.",
  cron: "10 6 * * 1-5",
  staleAfterSeconds: 3 * 3600,
  async run(_firing, ctx) {
    const min = await getSetting(ctx.db, "calendar.blockMinMinutes");
    return (await bigTasks(ctx, min)).map((taskId) => ({
      kind: "act" as const,
      action: "calendar.block_task",
      input: { taskId },
    }));
  },
};

export const blockReflex: ReflexDef = {
  name: "calendar.block_big_tasks",
  description:
    "When a big task is added, re-estimated, rescheduled or finished, its calendar blocks follow.",
  mode: "proactive",
  on: [
    "entity.created",
    "entity.updated",
    "task.status_changed",
    "task.due_changed",
    "task.assigned",
  ],
  run(event) {
    if (!event.entityId) return [];
    if (event.kind.startsWith("entity.")) {
      if (event.payload.type !== "task") return [];
      const changed = (event.payload.changed as string[] | undefined) ?? ["estimateMinutes"];
      if (!changed.includes("estimateMinutes")) return [];
    }
    // Wait a little, so a task edited several times in a row gets planned once.
    return [
      {
        kind: "check_later",
        key: `block:${event.entityId}`,
        at: new Date(event.at.getTime() + 2 * 60_000),
        payload: { taskId: event.entityId },
      },
    ];
  },
  async onCheck(payload) {
    return [{ kind: "act", action: "calendar.block_task", input: { taskId: payload.taskId } }];
  },
};
