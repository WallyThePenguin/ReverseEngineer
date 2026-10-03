// Command mode (PLAN.md section 7.2): select text in any app, hold the command hotkey and say
// what to do with it ("make this more formal"). Jarvis does it in its fast lane and the desktop
// app pastes the result over the selection. What you selected may have come from anywhere, so
// it's kept as outside content and the turn starts untrusted (D25).
import { PRINCIPAL } from "@hearth/core";
import { entity, jarvisTurn } from "@hearth/db";
import { createEntity, defineAction, notFound, type ReflexDef } from "@hearth/kernel";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { id, liveEntity, preview } from "../shared.ts";

export const COMMAND_TYPE = "voice_command";

export const commandActions = [
  defineAction({
    name: "voice.command",
    description:
      "Ask Jarvis to do something with the text selected in another app (a spoken command from the desktop app). Get the answer with voice.command_result.",
    input: z.object({
      instruction: z.string().trim().min(1).max(2_000),
      selection: z.string().max(20_000).default(""),
      app: z.string().max(200).optional(),
    }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
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
    risk: "read",
    callers: ["owner"],
    async handler(i, ctx) {
      if (!(await liveEntity(ctx.tx, i.id, COMMAND_TYPE))) throw notFound("Voice command");
      const [reply] = await ctx.tx
        .select({ body: entity.body })
        .from(entity)
        .where(
          and(
            eq(entity.parentId, i.id),
            eq(entity.type, "comment"),
            eq(entity.createdBy, PRINCIPAL.jarvis),
            isNull(entity.deletedAt),
          ),
        )
        .orderBy(desc(entity.createdAt))
        .limit(1);
      if (reply?.body) return { status: "done" as const, text: reply.body };
      const [turn] = await ctx.tx
        .select({ status: jarvisTurn.status, error: jarvisTurn.error })
        .from(jarvisTurn)
        .where(eq(jarvisTurn.subjectId, i.id))
        .orderBy(desc(jarvisTurn.queuedAt))
        .limit(1);
      if (turn && ["failed", "skipped", "canceled"].includes(turn.status))
        return { status: "failed" as const, reason: turn.error ?? "Jarvis couldn't do it." };
      if (turn?.status === "done")
        return { status: "failed" as const, reason: "Jarvis didn't answer." };
      return { status: "working" as const };
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
        untrusted: p.hasSelection,
        prompt: p.hasSelection
          ? `I selected the text in the record above${where} and said: "${p.instruction}"`
          : `I'm typing${where} and said: "${p.instruction}"`,
      },
    ];
  },
};
