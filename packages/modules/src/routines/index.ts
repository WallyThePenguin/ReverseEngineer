// Your routines (B2, step 3): things you ask Jarvis to do on a schedule, in your own words, like
// "every weekday at 7, check my bank's site for new statements". Each one gets a Jarvis turn
// when it's due, with all of Jarvis's tools, the browser included. The words are yours: a turn
// that has read outside content can't write or change them.
import { type DbOrTx, entity, routine, schedule } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  cancelSchedule,
  createEntity,
  type Describe,
  defineAction,
  defineModule,
  getSetting,
  type ReflexDef,
  requireEntity,
  trashEntity,
  updateEntity,
  upsertSchedule,
} from "@hearth/kernel";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { cronFor, describeCron, When } from "./when.ts";

const REFLEX = "routine.due";
const scheduleId = (routineId: string) => `routine-of:${routineId}`;

function refuseUntrusted(ctx: ActionContext): void {
  if (ctx.caller.origin === "untrusted")
    throw new ActionError(
      "forbidden",
      "A routine's instructions are the owner's own; they can't come from outside content.",
    );
}

async function scheduleRoutine(ctx: ActionContext, routineId: string, cron: string) {
  const rules = await getSetting(ctx.tx, "owner.dayRules");
  await upsertSchedule(
    ctx.tx,
    {
      id: scheduleId(routineId),
      kind: "check",
      cron,
      timeZone: rules.timeZone,
      payload: { reflex: REFLEX, routineId },
      staleAfterSeconds: 3 * 3600,
    },
    ctx.now,
  );
}

type RoutineRow = typeof routine.$inferSelect & { title: string };

async function loadRoutine(db: DbOrTx, routineId: string) {
  const [row] = await db
    .select({
      r: routine,
      title: entity.title,
      next: schedule.nextRunAt,
      last: schedule.lastRunAt,
      outcome: schedule.lastOutcome,
    })
    .from(routine)
    .innerJoin(entity, eq(entity.id, routine.entityId))
    .leftJoin(schedule, eq(schedule.id, scheduleId(routineId)))
    .where(and(eq(routine.entityId, routineId), isNull(entity.deletedAt)));
  return row
    ? {
        ...row.r,
        title: row.title,
        nextRunAt: row.next,
        lastRunAt: row.last,
        lastOutcome: row.outcome,
      }
    : null;
}

const view = (
  r: RoutineRow & { nextRunAt: Date | null; lastRunAt: Date | null; lastOutcome: string | null },
) => ({
  id: r.entityId,
  title: r.title,
  instructions: r.instructions,
  when: describeCron(r.cron),
  active: r.active,
  nextRunAt: r.active ? r.nextRunAt : null,
  lastRunAt: r.lastRunAt,
  /** How its last turn went: queued, retrying, done, failed, or skipped_* (D54). */
  lastOutcome: r.lastOutcome,
});

const describeRoutine: Describe = async (entityId, ctx) => {
  const r = await loadRoutine(ctx.db, entityId);
  if (!r) return null;
  return [
    `# ${r.title}`,
    `id: ${entityId} · routine · ${r.active ? describeCron(r.cron) : "paused"}`,
    "",
    r.instructions,
  ].join("\n");
};

const due: ReflexDef = {
  name: REFLEX,
  description: "When one of your routines is due, Pip does what it says.",
  // You asked for these, like a watch's follow-up, so they run while Jarvis is paused too.
  mode: "reactive",
  on: [],
  run: () => [],
  async onCheck(payload, ctx) {
    const routineId = String(payload.routineId);
    const r = await loadRoutine(ctx.db, routineId);
    if (!r || (!r.active && !payload.now)) return [];
    const at = String(payload.scheduledFor ?? ctx.event.at.toISOString());
    return [
      {
        kind: "turn",
        trigger: "routine",
        lane: "deep",
        subjectId: routineId,
        dedupeKey: `routine:${routineId}:${at}`,
        // How the turn went shows on the routine, Run now included (D54).
        context: { routine: r.title, scheduleId: scheduleId(routineId) },
        prompt: [
          `It's time for the owner's routine "${r.title}" (${describeCron(r.cron)}). They wrote:`,
          "",
          r.instructions,
          "",
          "Do it now. Anything that sends something still needs their yes, as usual. When you're done, say briefly what you did and what you found, as a comment on the routine (comment_create on its id).",
          `Then put it on the owner's Today with inbox_notify: kind "routine", entityId ${routineId}, a one-line title saying what you found, and the details in body.`,
        ].join("\n"),
      },
    ];
  },
};

const instructions = z.string().trim().min(1).max(4000);

export const routinesModule = defineModule({
  name: "routine",
  description: "Your own routines: what Pip does for you on a schedule, in your words.",
  entityTypes: ["routine"],
  kernelEvents: ["entity.created", "entity.updated", "entity.deleted"],
  events: [],
  knowledge: { routine: describeRoutine },
  reflexes: [due],
  actions: [
    defineAction({
      name: "routine.create",
      description:
        "Make a routine: something the owner wants done on a schedule, in their words (e.g. every weekday at 7:00, check the school portal for new grades and tell me).",
      input: z.object({ title: z.string().trim().min(1).max(200), instructions, when: When }),
      risk: "internal",
      callers: ["owner", "agent"],
      summarize: (i) => `Make the routine "${i.title}"`,
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        const cron = cronFor(i.when);
        const row = await createEntity(ctx, { type: "routine", title: i.title });
        await ctx.tx
          .insert(routine)
          .values({ entityId: row.id, instructions: i.instructions, cron });
        await scheduleRoutine(ctx, row.id, cron);
        return view((await loadRoutine(ctx.tx, row.id))!);
      },
    }),
    defineAction({
      name: "routine.update",
      description: "Change a routine's name, instructions or schedule, or pause and resume it.",
      input: z.object({
        id,
        title: z.string().trim().min(1).max(200).optional(),
        instructions: instructions.optional(),
        when: When.optional(),
        active: z.boolean().optional(),
      }),
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        const r = await loadRoutine(ctx.tx, i.id);
        if (!r) throw new ActionError("not_found", "No routine with that id.");
        if (i.title) await updateEntity(ctx, i.id, { title: i.title }, { type: "routine" });
        const cron = i.when ? cronFor(i.when) : r.cron;
        const active = i.active ?? r.active;
        await ctx.tx
          .update(routine)
          .set({ cron, active, ...(i.instructions ? { instructions: i.instructions } : {}) })
          .where(eq(routine.entityId, i.id));
        if (active) await scheduleRoutine(ctx, i.id, cron);
        else await cancelSchedule(ctx.tx, scheduleId(i.id));
        return view((await loadRoutine(ctx.tx, i.id))!);
      },
    }),
    defineAction({
      name: "routine.list",
      description: "The owner's routines: what each does, when, and when it last ran.",
      input: z.object({}),
      risk: "read",
      async handler(_i, ctx) {
        const rows = await ctx.tx
          .select({ id: routine.entityId })
          .from(routine)
          .innerJoin(entity, eq(entity.id, routine.entityId))
          .where(isNull(entity.deletedAt))
          .orderBy(entity.title);
        const out = [];
        for (const { id: rid } of rows) {
          const r = await loadRoutine(ctx.tx, rid);
          if (r) out.push(view(r));
        }
        return out;
      },
    }),
    defineAction({
      name: "routine.run_now",
      description: "Run a routine now, as well as on its schedule.",
      input: z.object({ id }),
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        const r = await loadRoutine(ctx.tx, i.id);
        if (!r) throw new ActionError("not_found", "No routine with that id.");
        if (!r.active && ctx.caller.kind !== "owner")
          throw new ActionError(
            "forbidden",
            "That routine is turned off; only the owner can run it.",
          );
        await upsertSchedule(
          ctx.tx,
          {
            id: `routine-now:${i.id}`,
            kind: "check",
            runAt: ctx.now,
            payload: { reflex: REFLEX, routineId: i.id, now: true },
          },
          ctx.now,
        );
        return { queued: true };
      },
    }),
    defineAction({
      name: "routine.remove",
      description: "Delete a routine. It stops at once.",
      input: z.object({ id }),
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        await requireEntity(ctx.tx, i.id, "routine");
        await trashEntity(ctx, i.id);
        await cancelSchedule(ctx.tx, scheduleId(i.id));
        return { removed: true };
      },
    }),
  ],
});
