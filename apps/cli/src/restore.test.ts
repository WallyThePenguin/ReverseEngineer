// The restore drill: back up, lose things, restore into a fresh database, check it all came back.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, loadMigrations, migrateDown, migrationState } from "@hearth/db";
import { adminUrl, createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobIntact, dataFolders, listBlobs, runBackup, runProgram } from "./backup.ts";
import { pickSnapshot, restoreReport, runRestore, switchEnv } from "./restore.ts";
import { dataFolder, type FakeRestic, fakeRestic } from "./testing/restic.ts";

let db: TestDatabase;
let dir: string;
let restic: FakeRestic | null = null;
const made: string[] = [];

const fresh = () => {
  const name = `hearth_restored_test_${randomBytes(4).toString("hex")}`;
  made.push(name);
  return name;
};
const records = async (url: string) => {
  const d = connect(url, { max: 1 });
  try {
    return Number((await d.pool.query("SELECT count(*) AS n FROM entity")).rows[0].n);
  } finally {
    await d.close();
  }
};
const version = /restic (\d+)\.(\d+)/.exec((await runProgram("restic", ["version"])).stdout);
const realRestic = !!version && (Number(version[1]) > 0 || Number(version[2]) >= 17);

const base = () => ({
  databaseUrl: db.url,
  repository: null,
  backupDir: dir,
  dataDir: join(dir, "data"),
});

// Each case backs up and restores whole databases: a few seconds alone, but 30 s and more while
// an update builds on the same PC, so they get longer than the 20 s default.
describe("hearth restore", { timeout: 90_000 }, () => {
  beforeEach(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "hearth-restore-test-"));
  });
  afterEach(async () => {
    const admin = connect(adminUrl(), { max: 1 });
    for (const name of made.splice(0))
      await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.close();
    await db.destroy();
    await restic?.destroy();
    restic = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("restores the newest backup into a fresh database, leaving Hearth's own alone", async () => {
    expect(
      (await runBackup({ databaseUrl: db.url, dir, repository: null, restoreDatabase: fresh() }))
        .ok,
    ).toBe(true);
    const into = fresh();
    const r = await runRestore({ ...base(), source: null, into });
    expect(r).toMatchObject({ database: into, migrated: [], records: await records(db.url) });
    expect(r.records).toBeGreaterThan(0);
    const copy = connect(r.url, { max: 1 });
    const state = await migrationState(copy.pool);
    await copy.close();
    expect(state).toMatchObject({ missing: [], unknown: [] });
    // The database it came from is untouched, and the same name can't be used twice.
    await expect(runRestore({ ...base(), source: null, into })).rejects.toThrow(/exists already/);
    await expect(runRestore({ ...base(), source: null, into: db.name })).rejects.toThrow(/runs on/);
    await expect(runRestore({ ...base(), source: null, into: "Not-A-Name" })).rejects.toThrow(
      /can't be a database name/,
    );
  });

  it("brings a backup from older code up to this code's migrations", async () => {
    const last = loadMigrations().at(-1)!.name;
    expect(await migrateDown(db.pool)).toEqual([last]);
    const file = join(dir, "older.dump");
    expect(
      (await runProgram("pg_dump", ["--format=custom", "--file", file, "--dbname", db.url])).code,
    ).toBe(0);
    const r = await runRestore({ ...base(), source: file, into: fresh() });
    expect(r.migrated).toEqual([last]);
    expect(r.from).toBe(file);
  });

  it("refuses a backup from newer code, and leaves no database behind", async () => {
    await db.pool.query("INSERT INTO _migration (name) VALUES ('9999_from_the_future')");
    const file = join(dir, "newer.dump");
    expect(
      (await runProgram("pg_dump", ["--format=custom", "--file", file, "--dbname", db.url])).code,
    ).toBe(0);
    const into = fresh();
    await expect(runRestore({ ...base(), source: file, into })).rejects.toThrow(
      /from a newer Hearth/,
    );
    const admin = connect(adminUrl(), { max: 1 });
    const left = await admin.pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [into]);
    await admin.close();
    expect(left.rowCount).toBe(0);
  });

  it("puts back lost stored files and voice samples from the same snapshot, never the vault key", async () => {
    restic = await fakeRestic();
    const data = await dataFolder(dir);
    const { blobs, voice } = dataFolders(data);
    const key = await readFile(join(data, "vault.key"));
    const backup = await runBackup(
      {
        databaseUrl: db.url,
        dir,
        repository: "fake",
        restoreDatabase: fresh(),
        folders: [blobs, voice],
      },
      restic.run,
    );
    expect(backup.ok).toBe(true);
    // Lose two stored files and the voice sample.
    const before = await listBlobs(blobs);
    for (const f of before.slice(0, 2)) await rm(f);
    await rm(join(voice, "one.wav"));

    const r = await runRestore(
      { ...base(), repository: "fake", source: null, into: fresh() },
      restic.run,
    );
    expect(r.files).toEqual({ blobs: 2, voice: 1 });
    expect(r.from).toMatch(/^backup 00000001/);
    expect((await listBlobs(blobs)).sort()).toEqual([...before].sort());
    for (const f of await listBlobs(blobs)) expect(await blobIntact(f, blobs)).toBe(true);
    expect(existsSync(join(voice, "one.wav"))).toBe(true);
    expect(await readFile(join(data, "vault.key"))).toEqual(key);
    const fetched = restic.calls.filter((c) => c[3] === "dump" || c[3] === "restore").flat();
    expect(fetched.some((a) => a.endsWith("vault.key"))).toBe(false);
    // Only the folders, fetched by name inside the snapshot; nothing left next to the data.
    expect(restic.calls.filter((c) => c[3] === "restore").every((c) => c[4]!.includes(":"))).toBe(
      true,
    );
    expect((await readdir(data)).filter((f) => f.startsWith(".restore-"))).toEqual([]);
  });

  // With restic itself (0.17 or newer, for `dump --target` and `<id>:<folder>`), when installed:
  // the Windows CI job installs it.
  it.skipIf(!realRestic)(
    "drills the whole way with real restic: back up, lose the files, restore",
    async () => {
      const repo = join(dir, "repo");
      process.env.RESTIC_PASSWORD = "hearth-test-only";
      try {
        expect((await runProgram("restic", ["--repo", repo, "init"])).code).toBe(0);
        const data = await dataFolder(dir);
        const { blobs, voice } = dataFolders(data);
        const b = await runBackup({
          databaseUrl: db.url,
          dir,
          repository: repo,
          restoreDatabase: fresh(),
          folders: [blobs, voice],
        });
        expect(b).toMatchObject({ ok: true, offsite: true });
        expect(b.detail).toContain("3 stored files checked");
        const lost = await listBlobs(blobs);
        await rm(blobs, { recursive: true });
        await rm(voice, { recursive: true });
        const r = await runRestore({
          ...base(),
          repository: repo,
          source: b.snapshot,
          into: fresh(),
        });
        expect(r.files).toEqual({ blobs: lost.length, voice: 1 });
        expect(r.records).toBe(await records(db.url));
        for (const f of await listBlobs(blobs)) expect(await blobIntact(f, blobs)).toBe(true);
      } finally {
        delete process.env.RESTIC_PASSWORD;
      }
    },
    120_000,
  );
});

describe("hearth restore, around the restore", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hearth-restore-test-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("picks the snapshot you name, or the newest", () => {
    const s = (id: string, time: string) => ({ id, short_id: id.slice(0, 8), time, paths: [] });
    const all = [s("aaaa1111", "2026-10-02T02:30:00Z"), s("bbbb2222", "2026-10-03T02:30:00Z")];
    expect(pickSnapshot(all, null)?.id).toBe("bbbb2222");
    expect(pickSnapshot(all, "latest")?.id).toBe("bbbb2222");
    expect(pickSnapshot(all, "aaaa")?.id).toBe("aaaa1111");
    expect(pickSnapshot(all, "cccc")).toBeNull();
  });

  it("switches .env to the restored database, keeping the old one to go back to", async () => {
    const env = join(dir, ".env");
    const old =
      "HEARTH_PORT=4400\nHEARTH_DATABASE_URL=postgres://hearth@localhost/hearth\nHEARTH_ORIGIN=https://x\n";
    await writeFile(env, old);
    const now = new Date("2026-10-04T16:50:12Z");
    const saved = await switchEnv(env, "postgres://hearth@localhost/hearth_restored_1", now);
    expect(saved).toBe(`${env}.before-restore-20261004_165012`);
    expect(await readFile(saved, "utf8")).toBe(old);
    expect(await readFile(env, "utf8")).toBe(old.replace("/hearth\n", "/hearth_restored_1\n"));

    await writeFile(env, "HEARTH_PORT=4400");
    await switchEnv(env, "postgres://x/y", now);
    expect(await readFile(env, "utf8")).toBe(
      "HEARTH_PORT=4400\nHEARTH_DATABASE_URL=postgres://x/y\n",
    );
  });

  it("says what came back and exactly how to switch", () => {
    const r = {
      database: "hearth_restored_20261004_165012",
      url: "postgres://hearth:secret@localhost/hearth_restored_20261004_165012",
      from: "backup 4f2a9c1e (2026-10-04 02:30)",
      records: 120,
      signIns: 2,
      migrated: ["0022_x"],
      files: { blobs: 3, voice: 1 },
    };
    const text = restoreReport(r, "postgres://hearth:secret@localhost/hearth", null, false);
    expect(text).toContain("120 records; every migration applied (1 added on top of the backup)");
    expect(text).toContain("from /hearth to /hearth_restored_20261004_165012");
    expect(text).toContain("Its 2 saved sign-ins");
    expect(text).not.toContain("secret");
    const none = restoreReport({ ...r, signIns: 0 }, "postgres://h@l/hearth", null, false);
    expect(none).not.toContain("sign-ins");
    const done = restoreReport(
      r,
      "postgres://hearth:secret@localhost/hearth",
      "C:\\Hearth\\.env.before-restore-1",
      true,
    );
    expect(done).toContain("Hearth now uses hearth_restored_20261004_165012");
    expect(done).not.toContain("sign-ins");
  });
});
