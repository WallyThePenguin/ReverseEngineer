// `hearth restore [snapshot | file.dump] [--into name] [--switch]`: brings a backup back into a
// NEW database, never over the one Hearth runs on, so a bad restore costs nothing. It restores the
// dump in one transaction (all or nothing), brings it up to this code's migrations, checks it, and
// puts back the stored files and voice samples that are missing here. Then it prints how to point
// Hearth at it, or with --switch does that: .env (keeping a copy) and a restart.
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { connect, migrateUp, migrationState } from "@hearth/db";
import {
  blobIntact,
  dataFolders,
  listBlobs,
  must,
  type Runner,
  runProgram,
  StepError,
  snapshotPath,
  withDatabase,
} from "./backup.ts";

export interface RestoreOptions {
  /** The database Hearth uses now; the restore goes next to it, on the same server. */
  databaseUrl: string;
  /** A snapshot id (or its first characters), "latest", or a .dump file. Null: the newest backup. */
  source: string | null;
  repository: string | null;
  /** Where `hearth backup` keeps its local dumps. */
  backupDir: string;
  /** Hearth's data folder: stored files and voice samples go back under it. */
  dataDir: string;
  /** The new database's name; hearth_restored_<date>_<time> by default. */
  into?: string;
  now?: Date;
}

export interface RestoreResult {
  database: string;
  url: string;
  from: string;
  records: number;
  /** Saved sign-ins: they open only with the vault key, which backups leave out (D29). */
  signIns: number;
  /** Migrations applied on top of the backup, which came from older code. */
  migrated: string[];
  files: { blobs: number; voice: number };
}

interface Snapshot {
  id: string;
  short_id?: string;
  time: string;
  paths: string[];
}

const leaf = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The snapshot to restore: the one named, or the newest of Hearth's. */
export function pickSnapshot(snapshots: Snapshot[], wanted: string | null): Snapshot | null {
  if (wanted && wanted !== "latest")
    return snapshots.find((s) => s.id.startsWith(wanted) || s.short_id === wanted) ?? null;
  return [...snapshots].sort((a, b) => b.time.localeCompare(a.time))[0] ?? null;
}

/** The newest .dump in the backup folder (nightly or taken before an update). */
async function newestDump(dir: string): Promise<string | null> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".dump"));
  const dated = await Promise.all(
    files.map(async (f) => ({ f, at: (await stat(join(dir, f))).mtimeMs })),
  );
  const newest = dated.sort((a, b) => b.at - a.at)[0];
  return newest ? join(dir, newest.f) : null;
}

/** Moves files from a restored folder into Hearth's, keeping any that are already there. */
async function putBack(from: string, to: string): Promise<string[]> {
  const moved: string[] = [];
  for (const entry of await readdir(from, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const src = join(entry.parentPath, entry.name);
    const dest = join(to, relative(from, src));
    if (existsSync(dest)) continue;
    await mkdir(join(dest, ".."), { recursive: true });
    await rename(src, dest).catch(() => copyFile(src, dest));
    moved.push(dest);
  }
  return moved;
}

const stampName = (d: Date) =>
  d
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14)
    .replace(/^(\d{8})/, "$1_");

export async function runRestore(
  opts: RestoreOptions,
  run: Runner = runProgram,
): Promise<RestoreResult> {
  const now = opts.now ?? new Date();
  const database = opts.into ?? `hearth_restored_${stampName(now)}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database))
    throw new StepError(
      `"${database}" can't be a database name: use lowercase letters, digits and _.`,
    );
  if (new URL(opts.databaseUrl).pathname === `/${database}`)
    throw new StepError(`Hearth runs on ${database} now; restore into a new database instead.`);
  // Next to the data (not in the system's temp folder): same drive, so files move, not copy.
  await mkdir(opts.dataDir, { recursive: true });
  const scratch = await mkdtemp(join(opts.dataDir, ".restore-"));
  const admin = connect(withDatabase(opts.databaseUrl, "postgres"), { max: 1 });
  let created = false;
  try {
    // What to restore from.
    let dump: string | null = null;
    let from = "";
    let snap: Snapshot | null = null;
    const repo = opts.repository ? ["--repo", opts.repository] : [];
    if (opts.source && (opts.source.endsWith(".dump") || existsSync(opts.source))) {
      dump = opts.source;
      from = opts.source;
    } else if (opts.repository) {
      const out = await must(run, "Listing backups", "restic", [
        ...repo,
        "snapshots",
        "--json",
        "--tag",
        "hearth",
      ]);
      snap = pickSnapshot(JSON.parse(out || "[]") as Snapshot[], opts.source);
      if (!snap)
        throw new StepError(
          `No backup ${opts.source ? `called ${opts.source} ` : ""}in ${opts.repository}.`,
        );
      const inside = snap.paths.find((p) => p.endsWith(".dump"));
      if (!inside) throw new StepError(`Backup ${snap.id.slice(0, 8)} has no database dump.`);
      dump = join(scratch, leaf(inside));
      await must(run, "Downloading the backup", "restic", [
        ...repo,
        "dump",
        snap.id,
        snapshotPath(inside),
        "--target",
        dump,
      ]);
      from = `backup ${snap.id.slice(0, 8)} (${snap.time.slice(0, 16).replace("T", " ")})`;
    } else {
      dump = opts.source ? null : await newestDump(opts.backupDir);
      if (!dump)
        throw new StepError(
          opts.source
            ? `${opts.source} isn't a file, and there's no backup repository (HEARTH_BACKUP_REPOSITORY) to find it in.`
            : `No backup to restore: nothing in ${opts.backupDir}, and no backup repository set.`,
        );
      from = dump;
    }

    // A fresh database, all or nothing.
    const taken = await admin.pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      database,
    ]);
    if (taken.rowCount)
      throw new StepError(
        `A database called ${database} exists already. Pick another name with --into.`,
      );
    await admin.pool.query(`CREATE DATABASE ${database}`);
    created = true;
    const url = withDatabase(opts.databaseUrl, database);
    await must(run, "Restoring the database", "pg_restore", [
      "--no-owner",
      "--single-transaction",
      "--exit-on-error",
      "--dbname",
      url,
      dump,
    ]);

    // Up to this code's migrations, then checked.
    const copy = connect(url, { max: 1 });
    let migrated: string[];
    let records: number;
    let signIns: number;
    try {
      const before = await migrationState(copy.pool);
      if (before.unknown.length)
        throw new StepError(
          `This backup is from a newer Hearth (it has ${before.unknown.join(", ")}). Update Hearth first, then restore it.`,
        );
      migrated = await migrateUp(copy.pool);
      const after = await migrationState(copy.pool);
      if (after.missing.length)
        throw new StepError(`Migrations didn't apply: ${after.missing.join(", ")}.`);
      const r = await copy.pool.query<{ n: string; s: string }>(
        "SELECT (SELECT count(*) FROM entity) AS n, (SELECT count(*) FROM vault_login) AS s",
      );
      records = Number(r.rows[0]?.n ?? 0);
      signIns = Number(r.rows[0]?.s ?? 0);
    } finally {
      await copy.close();
    }

    // Stored files and voice samples from the same snapshot, where missing here.
    const files = { blobs: 0, voice: 0 };
    const here = dataFolders(opts.dataDir);
    for (const kind of ["blobs", "voice"] as const) {
      const name = kind === "blobs" ? "blobs" : "voice-samples";
      const inside = snap?.paths.find((p) => leaf(p) === name);
      if (!snap || !inside) continue;
      const staged = join(scratch, name);
      await must(run, "Downloading stored files", "restic", [
        ...repo,
        "restore",
        `${snap.id}:${snapshotPath(inside)}`,
        "--target",
        staged,
      ]);
      if (kind === "blobs")
        for (const f of await listBlobs(staged))
          if (!(await blobIntact(f, staged)))
            throw new StepError(`A stored file came back changed (${leaf(f)}).`);
      files[kind] = (await putBack(staged, here[kind])).length;
    }
    created = false; // Keep it: it's the restore.
    return { database, url, from, records, signIns, migrated, files };
  } finally {
    if (created)
      await admin.pool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
    await admin.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Points .env's HEARTH_DATABASE_URL at the restored database, after copying .env to
 * .env.before-restore-<time> (the way back). Returns that copy's path.
 */
export async function switchEnv(envFile: string, url: string, now = new Date()): Promise<string> {
  const text = existsSync(envFile) ? await readFile(envFile, "utf8") : "";
  const saved = `${envFile}.before-restore-${stampName(now)}`;
  await writeFile(saved, text);
  const line = `HEARTH_DATABASE_URL=${url}`;
  const next = /^HEARTH_DATABASE_URL=.*$/m.test(text)
    ? text.replace(/^HEARTH_DATABASE_URL=.*$/m, line)
    : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  await writeFile(envFile, next);
  return saved;
}

/** What to tell you after a restore: what came back, and how to switch to it (or that it did). */
export function restoreReport(
  r: RestoreResult,
  current: string,
  switched: string | null,
  vaultKey: boolean,
): string {
  const lines = [
    `Restored ${r.from} into a new database, ${r.database}:`,
    `  ${r.records} records; every migration applied${r.migrated.length ? ` (${r.migrated.length} added on top of the backup)` : ""}.`,
  ];
  const n = (count: number, what: string) => `${count} ${what}${count === 1 ? "" : "s"}`;
  if (r.files.blobs || r.files.voice)
    lines.push(
      `  ${n(r.files.blobs, "stored file")} and ${n(r.files.voice, "voice file")} put back (any already here were kept).`,
    );
  if (r.signIns && !vaultKey)
    lines.push(
      `  Its ${r.signIns} saved sign-ins (Settings > Sign-ins) need saving again: their key never leaves the PC it was made on.`,
    );
  const was = new URL(current).pathname.slice(1);
  if (switched)
    lines.push(
      "",
      `Hearth now uses ${r.database}. Your old .env is in ${switched}, and the database ${was} is untouched:`,
      "to go back, put that file back as .env and run pnpm hearth restart all.",
    );
  else
    lines.push(
      "",
      `Hearth still runs on ${was}, untouched. To switch to the restored copy:`,
      `  1. In .env, change the database at the end of HEARTH_DATABASE_URL from /${was} to /${r.database}`,
      "  2. pnpm hearth restart all",
      "  3. pnpm hearth doctor",
      "To go back, change it back and restart. Or run the restore again with --switch to do 1 and 2.",
    );
  return lines.join("\n");
}
