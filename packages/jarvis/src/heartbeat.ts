// The heartbeat: every 25 minutes during the day, one model turn only if reflexes set something
// aside since the last one. Watching is free; thinking costs a turn.
import { asUntrusted } from "@hearth/core";
import { heartbeatItem } from "@hearth/db";
import type { HearthEvent, Kernel, ReflexOutcome } from "@hearth/kernel";
import { asc, inArray, isNull } from "drizzle-orm";
import { proactiveGate } from "./budget.ts";

export const HEARTBEAT = {
  name: "jarvis.heartbeat",
  description: "Every 25 minutes from 8 a.m. to 7 p.m.: one turn if anything was set aside for it.",
  cron: "*/25 8-18 * * *",
  staleAfterSeconds: 20 * 60,
};

export async function runHeartbeat(kernel: Kernel, event: HearthEvent): Promise<ReflexOutcome[]> {
  const now = kernel.clock.now();
  if (!(await proactiveGate(kernel.db, now)).open) return [];
  const items = await kernel.db
    .select()
    .from(heartbeatItem)
    .where(isNull(heartbeatItem.takenAt))
    .orderBy(asc(heartbeatItem.createdAt))
    .limit(50);
  if (items.length === 0) return [];
  await kernel.db
    .update(heartbeatItem)
    .set({ takenAt: now })
    .where(
      inArray(
        heartbeatItem.id,
        items.map((i) => i.id),
      ),
    );
  // What came from outside content (an email's subject) is still outside content now, so the
  // turn starts untrusted and the model sees which lines those are (D58).
  const untrusted = items.some((i) => i.origin === "untrusted");
  const line = (i: (typeof items)[number]) => {
    const text = `${i.text}${i.aboutId ? ` (record ${i.aboutId})` : ""}`;
    return `- ${i.origin === "untrusted" ? asUntrusted(text, "heartbeat item") : text}`;
  };
  const list = items.map(line).join("\n");
  return [
    {
      kind: "turn",
      trigger: "routine",
      lane: "fast",
      ...(untrusted ? { untrusted: true } : {}),
      dedupeKey: `heartbeat:${String(event.payload.scheduledFor)}`,
      // A turn that fails for good puts these back for the next heartbeat (D54).
      context: { routine: "heartbeat", items: items.length, itemIds: items.map((i) => i.id) },
      prompt: [
        "Heartbeat. These came up since your last check. For each, pick the lightest outcome:",
        "act, ask, tell (inbox_notify, only if it can't wait), note (jarvis_observe), or nothing.",
        "",
        list,
      ].join("\n"),
    },
  ];
}
