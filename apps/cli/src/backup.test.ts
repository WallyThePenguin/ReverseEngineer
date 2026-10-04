import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackupConfig,
  dataFolders,
  listBlobs,
  type Runner,
  runBackup,
  runProgram,
  snapshotId,
  snapshotPath,
} from "./backup.ts";
import { dataFolder, type FakeRestic, fakeRestic } from "./testing/restic.ts";

let db: TestDatabase;
let dir: string;
let cfg: BackupConfig;
let restic: FakeRestic | null = null;
beforeEach(async () => {
  db = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "hearth-backup-test-"));
  cfg = {
    databaseUrl: db.url,
    dir,
    repository: null,
    restoreDatabase: `hearth_restore_${randomBytes(4).toString("hex")}`,
  };
});
afterEach(async () => {
  await db.destroy();
  await restic?.destroy();
  restic = null;
  await rm(dir, { recursive: true, force: true });
});

describe("hearth backup", () => {
  it("dumps the database and proves it restores, even without off-site storage", async () => {
    const result = await runBackup(cfg);
    expect(result).toMatchObject({ ok: true, restoreTested: true, offsite: false });
    expect(result.detail).toMatch(/saved locally only.*records restored/);
    expect((await readdir(dir)).filter((f) => f.endsWith(".dump"))).toHaveLength(1);
  });

  it("uploads the dump with the stored files, never the vault key, and checks what came back", async () => {
    restic = await fakeRestic();
    const data = await dataFolder(dir);
    const { blobs, voice } = dataFolders(data);
    const missing = join(data, "not-there");
    const result = await runBackup(
      { ...cfg, repository: "rclone:gdrive:hearth", folders: [blobs, voice, missing] },
      restic.run,
    );
    expect(result).toMatchObject({ ok: true, offsite: true, restoreTested: true });
    expect(result.snapshot).toBe(restic.snapshots[0]!.id);
    expect(result.detail).toMatch(/records restored, 3 stored files checked\.$/);

    const calls = restic.calls.filter((c) => c[0] === "restic");
    expect(calls.map((c) => c[3])).toEqual(["backup", "forget", "dump", "dump", "dump", "dump"]);
    const backup = calls[0]!;
    expect(backup.slice(-3)).toEqual([expect.stringMatching(/\.dump$/), blobs, voice]);
    expect(backup).toContain("--exclude");
    expect(backup[backup.indexOf("--exclude") + 1]).toBe("vault.key");
    // Pruned across snapshots, whatever each one's dump is called; four weeks kept.
    const forget = calls[1]!;
    expect(forget[forget.indexOf("--group-by") + 1]).toBe("host,tags");
    expect(forget[forget.indexOf("--keep-weekly") + 1]).toBe("4");
    const restore = restic.calls.find((c) => c[0] === "pg_restore")!;
    expect(restore.at(-1)).toContain(".restore-check-");
  });

  it("fails the check when a stored file comes back changed", async () => {
    restic = await fakeRestic();
    const data = await dataFolder(dir, 1);
    const { blobs } = dataFolders(data);
    const tampering: Runner = async (cmd, args) => {
      const r = await restic!.run(cmd, args);
      if (args[2] === "backup") {
        const [blob] = await listBlobs(restic!.copyOf(blobs));
        await writeFile(blob!, "not what was sent");
      }
      return r;
    };
    const result = await runBackup(
      { ...cfg, repository: "rclone:gdrive:hearth", folders: [blobs] },
      tampering,
    );
    expect(result).toMatchObject({ ok: false, restoreTested: false });
    expect(result.detail).toMatch(/^Restore check failed: a stored file came back changed/);
  });

  it("reports which step failed, in words you can act on", async () => {
    const noRestic: Runner = async (cmd, args) =>
      cmd === "restic" ? { code: 127, stdout: "", stderr: "" } : runProgram(cmd, args);
    const r1 = await runBackup({ ...cfg, repository: "rclone:gdrive:hearth" }, noRestic);
    expect(r1).toMatchObject({ ok: false, restoreTested: false });
    expect(r1.detail).toBe("Upload failed: restic isn't installed or isn't on PATH");

    const badDump: Runner = async (cmd, args) =>
      cmd === "pg_dump"
        ? { code: 1, stdout: "", stderr: "pg_dump: error: connection refused" }
        : runProgram(cmd, args);
    const r2 = await runBackup(cfg, badDump);
    expect(r2.detail).toBe("Database dump failed: pg_dump: error: connection refused");
  });

  it("reads restic's snapshot id, and names paths inside a snapshot on every platform", () => {
    expect(snapshotId('{"message_type":"summary","snapshot_id":"abc"}')).toBe("abc");
    expect(snapshotId("not json")).toBeNull();
    expect(snapshotPath("/data/hearth.dump", "linux")).toBe("/data/hearth.dump");
    expect(snapshotPath("D:\\Hearth\\data\\blobs", "win32")).toBe("/D/Hearth/data/blobs");
  });
});
