// Whether Jarvis is up and well, read from system.status (D54): the banner in its pane and the
// dot on its button come from here.
import type { SystemStatus } from "./types.ts";

/** Jarvis checks in every 30 seconds; this long without one means it isn't running. */
export const QUIET_MS = 2 * 60_000;

export interface JarvisLiveness {
  /** When it was last heard from, if it isn't running now. */
  downSince: Date | null;
  /** What its turns are doing, when that isn't fine. */
  detail: string | null;
  /** Worth a red dot: not running, or its turns are failing. */
  unwell: boolean;
}

export function jarvisLiveness(s: SystemStatus | undefined, now = Date.now()): JarvisLiveness {
  const seen = s?.jarvisAlive ? Date.parse(s.jarvisAlive.at) : null;
  const downSince = seen !== null && now - seen > QUIET_MS ? new Date(seen) : null;
  const health = s?.components.jarvis;
  return {
    downSince,
    detail: health && health.status !== "ok" ? health.detail : null,
    unwell: downSince !== null || health?.status === "failing",
  };
}

/** How the routine's last turn went, in a word or two. */
export function outcomeLabel(outcome: string | null): string | null {
  if (!outcome) return null;
  if (outcome.startsWith("skipped")) return "skipped";
  return (
    {
      fired: "started",
      queued: "queued",
      retrying: "retrying",
      done: "finished",
      failed: "failed",
      canceled: "stopped",
    }[outcome] ?? null
  );
}
