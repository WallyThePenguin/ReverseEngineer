// The inbox alerts a failing Jarvis raises (D54): when a routine fails or something needs the
// owner, again after several failures in a row, and when Claude rejects one of its tools.
import { localDate } from "@hearth/core";
import type { jarvisTurn } from "@hearth/db";
import { getSetting, systemCaller } from "@hearth/kernel";
import type { Failure } from "./failures.ts";
import { failureStreak, STREAK_ALERT } from "./health.ts";
import type { EndEnv } from "./turn-end.ts";

type TurnRow = typeof jarvisTurn.$inferSelect;

/** Failures that need the owner (or a fix), however they started. */
const NEEDS_YOU = new Set(["invalid_request", "auth", "bad_tool"]);

const ROUTINE_NAMES: Record<string, string> = {
  brief: "your morning brief",
  journal: "the evening journal",
  memory: "the nightly memory update",
  prep: "meeting prep",
  heartbeat: "a heartbeat check",
};

/**
 * Alerts (pushed to the phone) on a routine failing and on anything that needs the owner, and
 * again after several failures in a row. Each is raised once per kind per day within a run of
 * failures, so a new outage after Jarvis recovered is never swallowed by an earlier one.
 */
export async function alertFailure(
  env: EndEnv,
  turn: TurnRow,
  f: Failure,
  said: string,
  fellBack: boolean,
): Promise<void> {
  const { kernel } = env;
  const now = kernel.clock.now();
  const { timeZone } = await getSetting(kernel.db, "owner.dayRules");
  const { failed, firstFailedId } = await failureStreak(kernel.db, now);
  const start = firstFailedId ?? turn.id;
  const notify = async (title: string, body: string, dedupeKey: string) => {
    const res = await kernel.execute(
      "inbox.notify",
      { kind: "system.alert", title, body, urgency: "interrupt", dedupeKey },
      systemCaller(),
    );
    if (res.status !== "ok") env.log(`alert "${title}" wasn't raised: ${JSON.stringify(res)}`);
  };
  const routine = turn.trigger === "routine" ? String(turn.context.routine ?? "") : null;
  if (routine !== null || NEEDS_YOU.has(f.kind)) {
    const what = routine ? (ROUTINE_NAMES[routine] ?? `"${routine}"`) : null;
    const title = what
      ? `Jarvis couldn't finish ${what}`
      : f.kind === "auth"
        ? "Jarvis is signed out of Claude"
        : "Jarvis's turns are failing";
    const body = fellBack ? `${said} Hearth published the plain version instead.` : said;
    await notify(title, body, `jarvis_failed:${f.kind}:${localDate(now, timeZone)}:${start}`);
  }
  if (failed >= STREAK_ALERT)
    await notify(
      `Jarvis has failed ${failed} turns in a row`,
      `The latest: ${said}`,
      `jarvis_streak:${start}`,
    );
}

/** Tells the owner a tool was left out because Claude rejected it: once per tool per restart. */
export async function alertLeftOut(env: EndEnv, tool: string, since: Date): Promise<void> {
  const res = await env.kernel.execute(
    "inbox.notify",
    {
      kind: "system.alert",
      title: "Jarvis is working without one of its tools",
      body: `Claude rejected the definition of ${tool}, so Jarvis left it out and carried on. Hearth needs a fix for it; the tool stays off until Jarvis restarts.`,
      urgency: "interrupt",
      dedupeKey: `jarvis_left_out:${tool}:${since.toISOString()}`,
    },
    systemCaller(),
  );
  if (res.status !== "ok") env.log(`the alert about ${tool} wasn't raised: ${JSON.stringify(res)}`);
}
