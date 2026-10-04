// `hearth backup`: dump the database, send it off-site with restic (to Google Drive through
// rclone) in one snapshot with the files Hearth keeps (mail's stored files, voice samples), prune
// old snapshots, then prove the backup works by restoring it into a scratch database and checking
// a few stored files byte for byte. The result goes to system.backup_finished, so a failure
// reaches your inbox. `hearth restore` (restore.ts) brings one back.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { connect } from "@hearth/db";

export interface BackupConfig {
  databaseUrl: string;
  /** Local folder for dumps before upload. */
  dir: string;
  /** restic repository, e.g. rclone:gdrive:hearth-backups. Null means local copies only. */
  repository: string | null;
  /** Database used for the restore check; dropped afterwards. */
  restoreDatabase: string;
  /** Folders that go in the same snapshot as the dump (those that exist): see dataFolders. */
  folders?: string[];
  keep?: { daily: number; weekly: number; monthly: number };
}

/** Never backed up: the key to saved sign-ins stays on this PC (D29). */
export const NEVER_BACKED_UP = "vault.key";

/** The folders of Hearth's own files that belong in a backup, under its data folder. */
export function dataFolders(dataDir: string): { blobs: string; voice: string } {
  return { blobs: join(dataDir, "blobs"), voice: join(dataDir, "voice-samples") };
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

export { must, StepError };

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-").slice(0, 19);

export function withDatabase(url: string, name: string): string {
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

/**
 * A file's path inside a restic snapshot: as it was, except on Windows, where C:\Hearth\x becomes
 * /C/Hearth/x. `restic dump` and `restic restore <id>:<folder>` take it, and fetch just that file
 * or folder: a whole-snapshot restore would also re-create C:\Users and the like under the target,
 * with their permissions, which a restore then can't write into.
 */
export function snapshotPath(file: string, platform = process.platform): string {
  if (platform !== "win32") return file;
  return `/${file.replace(/^([A-Za-z]):/, "$1").replace(/\\/g, "/")}`.replace(/^\/+/, "/");
}

/** Every stored file under a blobs folder (ab/cdef..., named by the SHA-256 of its bytes). */
export async function listBlobs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const prefix of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    for (const rest of await readdir(join(dir, prefix)).catch(() => [] as string[]))
      if (/^[0-9a-f]{62}$/.test(rest)) out.push(join(dir, prefix, rest));
  }
  return out;
}

/** Whether a stored file's bytes still match its name. */
export async function blobIntact(file: string, dir: string): Promise<boolean> {
  const name = relative(dir, file).split(sep).join("");
  const bytes = await readFile(file).catch(() => null);
  return !!bytes && createHash("sha256").update(bytes).digest("hex") === name;
}

/** Up to `n` of the stored files, spread across them. */
function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / n)]!);
}

/** Fetches a few stored files from the snapshot and checks each against its hash. */
async function checkBlobs(
  run: Runner,
  repo: string[],
  snapshot: string,
  blobs: string[],
  blobsDir: string,
  scratch: string,
): Promise<number> {
  const picked = sample(blobs, 3);
  for (const blob of picked) {
    const copy = join(scratch, "blobs", relative(blobsDir, blob));
    await mkdir(join(copy, ".."), { recursive: true });
    await must(run, "Download for the restore check", "restic", [
      ...repo,
      "dump",
      snapshot,
      snapshotPath(blob),
      "--target",
      copy,
    ]);
    if (!(await blobIntact(copy, join(scratch, "blobs"))))
      throw new StepError(
        `Restore check failed: a stored file came back changed (${basename(blob)})`,
      );
  }
  return picked.length;
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
  const keep = cfg.keep ?? { daily: 7, weekly: 4, monthly: 12 };
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
    let filesChecked = 0;
    if (cfg.repository) {
      const repo = ["--repo", cfg.repository];
      const folders: string[] = [];
      for (const f of cfg.folders ?? [])
        if ((await stat(f).catch(() => null))?.isDirectory()) folders.push(f);
      const blobsDir = folders.find((f) => basename(f) === "blobs");
      // Listed before the upload, so each is in the snapshot (stored files are only ever added).
      const blobs = blobsDir ? await listBlobs(blobsDir) : [];
      const out = await must(run, "Upload", "restic", [
        ...repo,
        "backup",
        "--json",
        "--tag",
        "hearth",
        "--host",
        "hearth",
        "--exclude",
        NEVER_BACKED_UP,
        file,
        ...folders,
      ]);
      snapshot = snapshotId(out);
      // Grouped by host and tag: each snapshot's dump has its own name, and restic's default
      // grouping (host and paths) put every snapshot in a group of one, so none was ever pruned.
      await must(run, "Pruning old backups", "restic", [
        ...repo,
        "forget",
        "--tag",
        "hearth",
        "--group-by",
        "host,tags",
        "--prune",
        "--keep-daily",
        String(keep.daily),
        "--keep-weekly",
        String(keep.weekly),
        "--keep-monthly",
        String(keep.monthly),
      ]);
      // Restore from the off-site copy, not the local file, so the check covers the upload. Into
      // the backup folder, not the system's temp folder: that's on C:, which may be full.
      scratch = await mkdtemp(join(cfg.dir, ".restore-check-"));
      restoreFrom = join(scratch, basename(file));
      await must(run, "Download for the restore check", "restic", [
        ...repo,
        "dump",
        snapshot ?? "latest",
        snapshotPath(file),
        "--target",
        restoreFrom,
      ]);
      if (blobsDir)
        filesChecked = await checkBlobs(run, repo, snapshot ?? "latest", blobs, blobsDir, scratch);
    }
    const restored = await checkRestore(cfg, run, restoreFrom);
    await pruneLocal(cfg.dir, cfg.repository ? 2 : 7);
    const mb = (size / 1024 / 1024).toFixed(1);
    const files = filesChecked
      ? `, ${filesChecked} stored file${filesChecked === 1 ? "" : "s"} checked`
      : "";
    return {
      ok: true,
      offsite: !!cfg.repository,
      snapshot,
      restoreTested: true,
      detail: cfg.repository
        ? `${mb} MB backed up off-site (snapshot ${snapshot?.slice(0, 8) ?? "?"}); ${restored}${files}.`
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
