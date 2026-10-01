// Hearth watching itself: disk space, backups and whether Jarvis is alive. Problems go through
// system.report, which tells you (system.alert_on_failure) even while Jarvis is paused.
import { statfs } from "node:fs/promises";
import { formatDateTime } from "@hearth/core";
import { setting } from "@hearth/db";
import { getSetting, type Kernel, systemCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";

type Status = "ok" | "degraded" | "failing";

export interface HealthReport {
  component: string;
  status: Status;
  detail: string;
}

export interface HealthOptions {
  /** The folder whose disk is checked (where Postgres and backups live). */
  dataDir: string;
  /** How long Jarvis can go quiet before it counts as down. */
  jarvisStaleMs?: number;
  backupStaleHours?: number;
}

const GB = 1024 ** 3;

async function lastReport(kernel: Kernel, component: string) {
  const [row] = await kernel.db
    .select()
    .from(setting)
    .where(eq(setting.key, `health.${component}`));
  return row
    ? { ...(row.value as { status: Status; detail: string; at: string }), updatedAt: row.updatedAt }
    : null;
}

export async function checkDisk(dir: string): Promise<HealthReport> {
  try {
    const s = await statfs(dir);
    const free = s.bavail * s.bsize;
    const share = free / (s.blocks * s.bsize);
    const detail = `${(free / GB).toFixed(1)} GB free (${Math.round(share * 100)}%)`;
    if (free < 1 * GB || share < 0.02) return { component: "disk", status: "failing", detail };
    if (free < 5 * GB || share < 0.08) return { component: "disk", status: "degraded", detail };
    return { component: "disk", status: "ok", detail };
  } catch (err) {
    return { component: "disk", status: "degraded", detail: `Couldn't check: ${String(err)}` };
  }
}

export async function checkHealth(kernel: Kernel, opts: HealthOptions): Promise<HealthReport[]> {
  const now = kernel.clock.now();
  const rules = await getSetting(kernel.db, "owner.dayRules");
  const reports: HealthReport[] = [{ component: "worker", status: "ok", detail: "Running" }];
  reports.push(await checkDisk(opts.dataDir));

  const backup = await lastReport(kernel, "backup");
  const staleHours = opts.backupStaleHours ?? 36;
  if (
    backup &&
    backup.status !== "failing" &&
    now.getTime() - new Date(backup.at).getTime() > staleHours * 3_600_000
  ) {
    reports.push({
      component: "backup",
      status: "failing",
      detail: `No backup since ${formatDateTime(new Date(backup.at), rules.timeZone)}. Check the backup task.`,
    });
  }

  const jarvis = await lastReport(kernel, "jarvis");
  const staleMs = opts.jarvisStaleMs ?? 5 * 60_000;
  if (jarvis && jarvis.status === "ok" && now.getTime() - jarvis.updatedAt.getTime() > staleMs) {
    reports.push({
      component: "jarvis",
      status: "failing",
      detail: `Jarvis hasn't checked in since ${formatDateTime(jarvis.updatedAt, rules.timeZone)}. Its service may have stopped.`,
    });
  }
  return reports;
}

export async function reportHealth(kernel: Kernel, reports: HealthReport[]): Promise<void> {
  const caller = systemCaller();
  for (const r of reports) {
    await kernel.execute("system.report", r, caller);
    // Jarvis delivers system alerts, so if Jarvis itself is down the worker tells you directly.
    if (r.component === "jarvis" && r.status === "failing") {
      await kernel.execute(
        "inbox.notify",
        {
          kind: "system.alert",
          title: "Jarvis is down",
          body: r.detail,
          urgency: "normal",
          dedupeKey: `jarvis_down:${kernel.clock.now().toISOString().slice(0, 10)}`,
        },
        caller,
      );
    }
  }
}
