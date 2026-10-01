// The daily turn budget for proactive work. Model turns share the owner's Max rate limit with
// their own Claude use, so Jarvis's initiative is rationed; answering the owner never is.
import { startOfLocalDay } from "@hearth/core";
import { type DbOrTx, jarvisTurn } from "@hearth/db";
import { getSetting } from "@hearth/kernel";
import { and, count, eq, gte, inArray } from "drizzle-orm";

export type Gate = { open: true } | { open: false; reason: "paused" | "budget" };

export async function proactiveTurnsToday(db: DbOrTx, now: Date): Promise<number> {
  const rules = await getSetting(db, "owner.dayRules");
  const [row] = await db
    .select({ n: count() })
    .from(jarvisTurn)
    .where(
      and(
        eq(jarvisTurn.mode, "proactive"),
        inArray(jarvisTurn.status, ["queued", "running", "done", "failed"]),
        gte(jarvisTurn.queuedAt, startOfLocalDay(now, rules.timeZone)),
      ),
    );
  return row?.n ?? 0;
}

/** Whether a proactive turn may be spent now. */
export async function proactiveGate(db: DbOrTx, now: Date): Promise<Gate> {
  if (await getSetting(db, "jarvis.paused")) return { open: false, reason: "paused" };
  const limit = await getSetting(db, "jarvis.proactiveTurnsPerDay");
  if ((await proactiveTurnsToday(db, now)) >= limit) return { open: false, reason: "budget" };
  return { open: true };
}
