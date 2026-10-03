// Command mode (PLAN.md section 7.2): select text in any app, hold the command hotkey and say
// what to do with it ("make this more formal"). Jarvis does it in its fast lane and the desktop
// app pastes the result over the selection. What you selected may have come from anywhere, and
// the answer is pasted where nothing can approve it, so the turn is untrusted and has no tools:
// it can only rewrite what it was given (D42). The record is deleted once its answer is fetched.
import { entity, jarvisTurn } from "@hearth/db";
import { createEntity, defineAction, notFound, type ReflexDef } from "@hearth/kernel";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { id, liveEntity, preview } from "../shared.ts";

export const COMMAND_TYPE = "voice_command";
/** Commands nobody fetched are deleted after this long. */
const KEEP_MS = 15 * 60_000;

export const commandActions = [
  defineAction({
    name: "voice.command",
    description:
      "Ask Jarvis to do something with the text selected in another app (a spoken command from the desktop app). Get the answer with voice.command_result.",
    input: z.object({
      instruction: z.string().trim().min(1).max(2_000),
      selection: z.string().max(20_000).default(""),
      /** The program's name, like Slack.exe; never a window title (those can come from a page). */
      app: z
        .string()
        .regex(/^[\w .-]{1,64}$/)
        .optional(),
    }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      await ctx.tx
        .delete(entity)
        .where(
          and(
            eq(entity.type, COMMAND_TYPE),
            lt(entity.createdAt, new Date(ctx.now.getTime() - KEEP_MS)),
          ),
        );
      const row = await createEntity(ctx, {
        type: COMMAND_TYPE,
        title: preview(i.instruction, 80),
        body: i.selection,
      });
      ctx.emit({
        kind: "voice.commanded",
        entityId: row.id,
        payload: { instruction: i.instruction, hasSelection: i.selection.length > 0, app: i.app },
      });
      return { id: row.id };
    },
  }),
  defineAction({
    name: "voice.command_result",
    description: "What Jarvis made of a voice command: still working, its text, or why it failed.",
    input: z.object({ id }),
    // Deletes the command once it has its answer.
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      if (!(await liveEntity(ctx.tx, i.id, COMMAND_TYPE))) throw notFound("Voice command");
      // The command's own turn's answer, never a comment someone else could leave on it.
      const [turn] = await ctx.tx
        .select({ status: jarvisTurn.status, reply: jarvisTurn.reply, error: jarvisTurn.error })
        .from(jarvisTurn)
        .where(and(eq(jarvisTurn.subjectId, i.id), eq(jarvisTurn.trigger, "voice_command")))
        .orderBy(desc(jarvisTurn.queuedAt))
        .limit(1);
      const settled = turn && !["queued", "running"].includes(turn.status);
      if (!settled) return { status: "working" as const };
      await ctx.tx.delete(entity).where(eq(entity.id, i.id));
      if (turn.status === "done" && turn.reply?.trim())
        return { status: "done" as const, text: turn.reply.trim() };
      return {
        status: "failed" as const,
        reason:
          turn.error ??
          (turn.status === "done" ? "Jarvis didn't answer." : "Jarvis couldn't do it."),
      };
    },
  }),
];

export const commandReflex: ReflexDef = {
  name: "voice.command",
  description: "Jarvis does what you said with the text you selected, in its fast lane.",
  mode: "reactive",
  on: ["voice.commanded"],
  run(event) {
    const p = event.payload as { instruction: string; hasSelection: boolean; app?: string };
    const where = p.app ? ` in ${p.app}` : "";
    return [
      {
        kind: "turn",
        trigger: "voice_command",
        lane: "fast",
        subjectId: event.entityId,
        dedupeKey: `voice_command:${event.entityId}`,
        untrusted: true,
        prompt: p.hasSelection
          ? `I selected the text in the record above${where} and said: "${p.instruction}"`
          : `I'm typing${where} and said: "${p.instruction}"`,
      },
    ];
  },
};
