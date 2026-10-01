// What Jarvis does about tasks: works the ones assigned to it, answers in their threads, and
// warns before deadlines.
import {
  formatDateTime,
  isClosedStatus,
  JARVIS_ENTITY_ID,
  mentionContext,
  parseMentions,
} from "@hearth/core";
import { getSetting, type ReflexDef } from "@hearth/kernel";
import { liveEntity } from "../shared.ts";
import { loadTask } from "./view.ts";

export const workAssigned: ReflexDef = {
  name: "tasks.work_assigned",
  description:
    "When you assign a task to Jarvis, it starts working on it and reports in the task's thread.",
  mode: "reactive",
  on: ["task.assigned"],
  run(event) {
    if (event.payload.to !== "jarvis") return [];
    const key = `T-${event.payload.number}`;
    return [
      {
        kind: "turn",
        trigger: "assignment",
        lane: "deep",
        subjectId: event.entityId,
        dedupeKey: `assigned:${event.entityId}:${event.id}`,
        prompt: [
          `You've been assigned task ${key}, "${event.payload.title}". Work it now.`,
          "Read the task and its thread first. Move it to in_progress when you start.",
          "Do what you can with your tools, and anything outward will wait for approval.",
          "When done, move it to in_review and summarize what you did and what's left.",
          "If you can't do it, say exactly why and assign it back to the owner.",
        ].join("\n"),
      },
    ];
  },
};

export const answerTaskThread: ReflexDef = {
  name: "tasks.answer_thread",
  description:
    "When you comment on a task Jarvis is working, Jarvis reads it and answers in the thread.",
  mode: "reactive",
  on: ["entity.created"],
  async run(event, ctx) {
    if (event.payload.type !== "comment" || !event.payload.parentId) return [];
    const parent = await loadTask(ctx.db, { id: String(event.payload.parentId) });
    if (parent?.assignee !== "jarvis" || isClosedStatus(parent.status)) return [];
    const comment = await liveEntity(ctx.db, event.entityId!);
    if (!comment) return [];
    // An explicit @Jarvis is handled by the chat module's mention reflex.
    if (parseMentions(comment.body ?? "").some((m) => m.id === JARVIS_ENTITY_ID)) return [];
    return [
      {
        kind: "turn",
        trigger: "assignment",
        lane: "fast",
        subjectId: parent.id,
        dedupeKey: `thread:${comment.id}`,
        prompt: `New comment on ${parent.key}, which you're working on:\n\n${mentionContext(comment.body ?? "", 0)}`,
      },
    ];
  },
};

export const dueSoon: ReflexDef = {
  name: "tasks.due_soon",
  description: "Warns you before a task is due (24 hours by default), even when Jarvis is paused.",
  mode: "always",
  on: ["entity.created", "task.due_changed", "task.status_changed"],
  includeJarvisEvents: true,
  async run(event, ctx) {
    if (event.kind === "entity.created" && event.payload.type !== "task") return [];
    const t = await loadTask(ctx.db, { id: event.entityId! });
    if (!t?.dueAt || isClosedStatus(t.status)) return [];
    const hours = await getSetting(ctx.db, "tasks.dueSoonHours");
    const warnAt = new Date(Math.max(ctx.now.getTime(), t.dueAt.getTime() - hours * 3600_000));
    if (t.dueAt.getTime() <= ctx.now.getTime()) return [];
    return [
      {
        kind: "check_later",
        key: t.id,
        at: warnAt,
        payload: { taskId: t.id, dueAt: t.dueAt.toISOString() },
      },
    ];
  },
  async onCheck(payload, ctx) {
    const t = await loadTask(ctx.db, { id: String(payload.taskId) });
    if (!t?.dueAt || isClosedStatus(t.status) || t.dueAt.toISOString() !== payload.dueAt) return [];
    return [
      {
        kind: "tell",
        notification: {
          kind: "task.due_soon",
          title: `${t.key} "${t.title}" is due ${formatDateTime(t.dueAt)}`,
          entityId: t.id,
          urgency: "interrupt",
          deadline: t.dueAt,
          dedupeKey: `due_soon:${t.id}:${t.dueAt.toISOString()}`,
        },
      },
    ];
  },
};

export const TASK_REFLEXES = [workAssigned, answerTaskThread, dueSoon];
