// Hearth watching itself: disk space on every drive it uses, backups and whether Jarvis is alive
// (the syncs are in sync-health.ts). Problems go through system.report, which tells you itself,
// so it reaches you while Jarvis is paused or stopped.
import { stat, statfs } from "node:fs/promises";
import { parse, resolve } from "node:path";
import { formatDateTime } from "@hearth/core";
import { setting } from "@hearth/db";
import { getSetting, type Kernel, systemCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";

type Status = "ok" | "degraded" | "failing";

export interface HealthReport {
  component: string;
  status: Status;
  detail: string;
  /** Tells one outage from the next, so each gets its own alert. */
  key?: string;
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

/**
 * Judges free space in gigabytes, not as a share: Hearth writes little (its database is tens of
 * MB), and 2% of a 1 TB drive is 18 GB, which would call a fine disk failing and block updates.
 */
export function diskStatus(freeBytes: number): Status {
  if (freeBytes < 2 * GB) return "failing";
  if (freeBytes < 10 * GB) return "degraded";
  return "ok";
}

export async function checkDisk(dir: string): Promise<HealthReport> {
  try {
    const s = await statfs(dir);
    const free = s.bavail * s.bsize;
    const share = free / (s.blocks * s.bsize);
    const detail = `${(free / GB).toFixed(1)} GB free (${Math.round(share * 100)}%)`;
    return { component: "disk", status: diskStatus(free), detail };
  } catch (err) {
    return { component: "disk", status: "degraded", detail: `Couldn't check: ${String(err)}` };
  }
}

/**
 * The folders Hearth needs room in: its data (database dumps, mail), its own folder, the service
 * logs under ProgramData, and the system drive, where Node, Chrome and the Claude login live.
 */
export function hearthFolders(dataDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    dataDir,
    process.cwd(),
    env.HEARTH_BACKUP_DIR,
    env.ProgramData,
    env.SystemDrive ? `${env.SystemDrive}\\` : undefined,
  ].filter((d): d is string => Boolean(d));
}

/** Free space on each drive the folders are on, one entry per drive. */
export async function checkDrives(dirs: string[]): Promise<(HealthReport & { drive: string })[]> {
  const seen = new Set<number>();
  const out: (HealthReport & { drive: string })[] = [];
  for (const dir of dirs) {
    const dev = await stat(dir).then(
      (s) => s.dev,
      () => null,
    );
    if (dev === null || seen.has(dev)) continue;
    seen.add(dev);
    const root = parse(resolve(dir)).root;
    // "C:" on Windows; elsewhere the folder itself, since one root holds every disk.
    const drive = /^[A-Za-z]:\\$/.test(root) ? root.slice(0, 2).toUpperCase() : dir;
    out.push({ ...(await checkDisk(dir)), drive });
  }
  return out;
}

/** One "disk" report for all the drives: the worst of them, each named. */
export async function checkDisks(dirs: string[]): Promise<HealthReport> {
  const drives = await checkDrives(dirs);
  if (!drives.length) return { component: "disk", status: "degraded", detail: "No drive to check" };
  const rank: Record<Status, number> = { ok: 0, degraded: 1, failing: 2 };
  const worst = drives.reduce((a, b) => (rank[b.status] > rank[a.status] ? b : a));
  return {
    component: "disk",
    status: worst.status,
    detail: drives.map((d) => `${d.drive} ${d.detail}`).join(" · "),
  };
}

export async function checkHealth(kernel: Kernel, opts: HealthOptions): Promise<HealthReport[]> {
  const now = kernel.clock.now();
  const rules = await getSetting(kernel.db, "owner.dayRules");
  const reports: HealthReport[] = [{ component: "worker", status: "ok", detail: "Running" }];
  reports.push(await checkDisks(hearthFolders(opts.dataDir)));

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

  // Jarvis says it's alive every 30 seconds, whatever its turns are doing (D54). One from before
  // that is judged by its own health report, while that still says ok.
  const alive = await getSetting(kernel.db, "jarvis.alive");
  const jarvis = await lastReport(kernel, "jarvis");
  const seen = alive ? new Date(alive.at) : jarvis?.status === "ok" ? jarvis.updatedAt : null;
  const staleMs = opts.jarvisStaleMs ?? 5 * 60_000;
  if (seen && now.getTime() - seen.getTime() > staleMs) {
    reports.push({
      component: "jarvis",
      status: "failing",
      detail: `Pip hasn't checked in since ${formatDateTime(seen, rules.timeZone)}. Its service may have stopped.`,
      key: `jarvis_down:${seen.toISOString()}`,
    });
  }
  return reports;
}

export async function reportHealth(kernel: Kernel, reports: HealthReport[]): Promise<void> {
  const caller = systemCaller();
  for (const { key, ...r } of reports) {
    await kernel.execute("system.report", r, caller);
    // Jarvis delivers system alerts, so if Jarvis itself is down the worker tells you directly.
    if (r.component === "jarvis" && r.status === "failing") {
      await kernel.execute(
        "inbox.notify",
        {
          kind: "system.alert",
          title: "Pip is down",
          body: r.detail,
          urgency: "normal",
          dedupeKey: key ?? `jarvis_down:${kernel.clock.now().toISOString().slice(0, 10)}`,
        },
        caller,
      );
    }
  }
}
