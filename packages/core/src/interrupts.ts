// The interrupt budget, carried over from Jarvis: at most 8 interrupts a day, quiet hours from
// 10 p.m. to 8 a.m., a deadline within 24 hours breaks through the cap, and ambiguity fails
// toward silence.
import { type DayRules, DEFAULT_DAY_RULES, isQuietHours, nextLocalTime } from "./time.ts";

export interface InterruptPolicy {
  maxPerDay: number;
  rules: DayRules;
}

export const DEFAULT_INTERRUPT_POLICY: InterruptPolicy = { maxPerDay: 8, rules: DEFAULT_DAY_RULES };

export interface InterruptRequest {
  now: Date;
  /** Interrupts already delivered since local midnight. */
  deliveredToday: number;
  /** When the thing this is about is due, if anything. */
  deadline?: Date | null;
}

export type InterruptDecision =
  | { deliver: true; reason: "within_budget" | "deadline_breakthrough" }
  | { deliver: false; reason: "quiet_hours" | "budget_spent"; retryAt: Date | null };

const DAY_MS = 24 * 60 * 60 * 1000;

export function decideInterrupt(
  req: InterruptRequest,
  policy: InterruptPolicy = DEFAULT_INTERRUPT_POLICY,
): InterruptDecision {
  const { now, deadline } = req;
  const urgent = deadline != null && deadline.getTime() - now.getTime() < DAY_MS;

  if (isQuietHours(now, policy.rules)) {
    const morning = nextLocalTime(now, policy.rules.quietEnd, policy.rules.timeZone);
    // Waking you is only worth it when waiting until morning would miss the deadline.
    if (urgent && deadline.getTime() <= morning.getTime()) {
      return { deliver: true, reason: "deadline_breakthrough" };
    }
    return { deliver: false, reason: "quiet_hours", retryAt: morning };
  }
  if (req.deliveredToday < policy.maxPerDay) return { deliver: true, reason: "within_budget" };
  if (urgent) return { deliver: true, reason: "deadline_breakthrough" };
  return { deliver: false, reason: "budget_spent", retryAt: null };
}
