// `hearth backup`: dump the database, send it off-site with restic (to Google Drive through
// rclone), prune old snapshots, then prove the backup works by restoring it into a scratch
// database. The result goes to system.backup_finished, so a failure reaches your inbox.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@hearth/db";

export interface BackupConfig {
  databaseUrl: string;
  /** Local folder for dumps before upload. */
  dir: string;
  /** restic repository, e.g. rclone:gdrive:hearth-backups. Null means local copies only. */
  repository: string | null;
  /** Database used for the restore check; dropped afterwards. */
  restoreDatabase: string;
  keep?: { daily: number; weekly: number; monthly: number };
}

export interface BackupResult {
  ok: boolean;
  detail: string;
  snapshot: string | null;
  restoreTested: boolean;
  offsite: boolean;
}

export type Runner = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs a program without a shell, so arguments are never re-parsed. */
export const runProgram: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

class StepError extends Error {}

async function must(run: Runner, step: string, cmd: string, args: string[]): Promise<string> {
  const r = await run(cmd, args);
  if (r.code !== 0) {
    const why =
      r.code === 127
        ? `${cmd} isn't installed or isn't on PATH`
        : r.stderr.trim().split("\n").slice(-3).join(" ");
    throw new StepError(`${step} failed: ${why}`);
  }
  return r.stdout;
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-").slice(0, 19);

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** restic prints JSON lines; the summary line carries the new snapshot's id. */
export function snapshotId(output: string): string | null {
  for (const line of output.split("\n").reverse()) {
    try {
      const msg = JSON.parse(line) as { message_type?: string; snapshot_id?: string };
      if (msg.message_type === "summary" && msg.snapshot_id) return msg.snapshot_id;
    } catch {}
  }
  return null;
}

/** Restores a dump into a scratch database and checks it has the same migrations as the live one. */
async function checkRestore(cfg: BackupConfig, run: Runner, dumpFile: string): Promise<string> {
  const admin = connect(withDatabase(cfg.databaseUrl, "postgres"), { max: 1 });
  const name = cfg.restoreDatabase;
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new StepError(`Bad restore database name ${name}`);
  try {
    await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.pool.query(`CREATE DATABASE ${name}`);
    await must(run, "Restore check", "pg_restore", [
      "--no-owner",
      "--exit-on-error",
      "--dbname",
      withDatabase(cfg.databaseUrl, name),
      dumpFile,
    ]);
    const live = connect(cfg.databaseUrl, { max: 1 });
    const copy = connect(withDatabase(cfg.databaseUrl, name), { max: 1 });
    try {
      const q =
        "SELECT (SELECT string_agg(name, ',' ORDER BY name) FROM _migration) AS migrations, (SELECT count(*) FROM entity) AS records";
      const [a, b] = await Promise.all([live.pool.query(q), copy.pool.query(q)]);
      if (a.rows[0].migrations !== b.rows[0].migrations)
        throw new StepError("Restore check failed: the restored copy is missing migrations");
      if (Number(b.rows[0].records) < 2)
        throw new StepError("Restore check failed: the restored copy has no records");
      return `${b.rows[0].records} records restored`;
    } finally {
      await Promise.all([live.close(), copy.close()]);
    }
  } finally {
    await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.close();
  }
}

/** Where restic puts a restored file: under the target, at its original path ("C:" becomes "C"). */
export function restoredPath(target: string, file: string, platform = process.platform): string {
  return join(target, platform === "win32" ? file.replace(/^([A-Za-z]):/, "$1") : file);
}

/** Keeps the newest `keep` local dumps. */
async function pruneLocal(dir: string, keep: number): Promise<void> {
  const files = (await readdir(dir)).filter((f) => /^hearth-.*\.dump$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep)))
    await rm(join(dir, f), { force: true });
}

export async function runBackup(
  cfg: BackupConfig,
  run: Runner = runProgram,
  now = new Date(),
): Promise<BackupResult> {
  const keep = cfg.keep ?? { daily: 7, weekly: 5, monthly: 12 };
  let snapshot: string | null = null;
  let scratch: string | null = null;
  try {
    await mkdir(cfg.dir, { recursive: true });
    const file = join(cfg.dir, `hearth-${stamp(now)}.dump`);
    await must(run, "Database dump", "pg_dump", [
      "--format=custom",
      "--file",
      file,
      "--dbname",
      cfg.databaseUrl,
    ]);
    const size = (await stat(file)).size;

    let restoreFrom = file;
    if (cfg.repository) {
      const repo = ["--repo", cfg.repository];
      const out = await must(run, "Upload", "restic", [
        ...repo,
        "backup",
        "--json",
        "--tag",
        "hearth",
        "--host",
        "hearth",
        file,
      ]);
      snapshot = snapshotId(out);
      await must(run, "Pruning old backups", "restic", [
        ...repo,
        "forget",
        "--tag",
        "hearth",
        "--prune",
        "--keep-daily",
        String(keep.daily),
        "--keep-weekly",
        String(keep.weekly),
        "--keep-monthly",
        String(keep.monthly),
      ]);
      // Restore from the off-site copy, not the local file, so the check covers the upload.
      scratch = await mkdtemp(join(tmpdir(), "hearth-restore-"));
      await must(run, "Download for the restore check", "restic", [
        ...repo,
        "restore",
        snapshot ?? "latest",
        "--target",
        scratch,
      ]);
      restoreFrom = restoredPath(scratch, file);
    }
    const restored = await checkRestore(cfg, run, restoreFrom);
    await pruneLocal(cfg.dir, cfg.repository ? 2 : 7);
    const mb = (size / 1024 / 1024).toFixed(1);
    return {
      ok: true,
      offsite: !!cfg.repository,
      snapshot,
      restoreTested: true,
      detail: cfg.repository
        ? `${mb} MB backed up off-site (snapshot ${snapshot?.slice(0, 8) ?? "?"}); ${restored}.`
        : `${mb} MB saved locally only; off-site backup isn't set up yet. ${restored}.`,
    };
  } catch (err) {
    return {
      ok: false,
      offsite: !!cfg.repository,
      snapshot,
      restoreTested: false,
      detail: err instanceof StepError ? err.message : `Backup failed: ${String(err)}`,
    };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
