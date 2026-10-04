// A health report is only as good as it is fresh. A component that checks in every minute and
// hasn't for more than two is as good as down, whatever it last said (R2): a dead worker's last
// "ok" must not stay green.
import type { HealthRecord } from "./index.ts";

/** How often each component reports. Components not listed are never judged stale. */
export const REPORT_EVERY_MS: Readonly<Record<string, number>> = {
  worker: 60_000,
  disk: 60_000,
  jarvis: 60_000,
  backup: 24 * 3_600_000,
};

export interface JudgedHealth extends HealthRecord {
  /** True when the component stopped reporting; status is then "failing". */
  stale: boolean;
}

/** "3 min", "5 h", "2 days": how long ago, roughly. */
export function roughly(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 120) return `${min} min`;
  const h = Math.round(ms / 3_600_000);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** A component's last report, failing if it's more than twice its interval old. */
export function judgeHealth(component: string, record: HealthRecord, now: Date): JudgedHealth {
  const every = REPORT_EVERY_MS[component];
  const age = now.getTime() - new Date(record.at).getTime();
  if (!every || !(age > 2 * every)) return { ...record, stale: false };
  return {
    status: "failing",
    detail: `No report for ${roughly(age)} (last: ${record.detail || record.status}).`,
    at: record.at,
    stale: true,
  };
}
