import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackupConfig,
  type Runner,
  restoredPath,
  runBackup,
  runProgram,
  snapshotId,
} from "./backup.ts";

let db: TestDatabase;
let dir: string;
let cfg: BackupConfig;
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
  await rm(dir, { recursive: true, force: true });
});

/** restic, faked: remembers uploads and restores them where real restic would. */
function fakeRestic(calls: string[][]): Runner {
  let uploaded = "";
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== "restic") return runProgram(cmd, args);
    const sub = args[2];
    if (sub === "backup") {
      uploaded = args.at(-1)!;
      const summary = { message_type: "summary", snapshot_id: "4f2a9c1e0b7d" };
      return {
        code: 0,
        stdout: `{"message_type":"status"}\n${JSON.stringify(summary)}\n`,
        stderr: "",
      };
    }
    if (sub === "restore") {
      const target = restoredPath(args[args.indexOf("--target") + 1]!, uploaded);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(uploaded, target);
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("hearth backup", () => {
  it("dumps the database and proves it restores, even without off-site storage", async () => {
    const result = await runBackup(cfg);
    expect(result).toMatchObject({ ok: true, restoreTested: true, offsite: false });
    expect(result.detail).toMatch(/saved locally only.*records restored/);
    expect((await readdir(dir)).filter((f) => f.endsWith(".dump"))).toHaveLength(1);
  });

  it("uploads with restic, prunes, and restores the uploaded copy for the check", async () => {
    const calls: string[][] = [];
    const result = await runBackup(
      { ...cfg, repository: "rclone:gdrive:hearth" },
      fakeRestic(calls),
    );
    expect(result).toMatchObject({
      ok: true,
      offsite: true,
      snapshot: "4f2a9c1e0b7d",
      restoreTested: true,
    });
    const restic = calls.filter((c) => c[0] === "restic").map((c) => c[3]);
    expect(restic).toEqual(["backup", "forget", "restore"]);
    const restore = calls.find((c) => c[0] === "pg_restore")!;
    expect(restore.at(-1)).toContain("hearth-restore-");
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

  it("reads restic's snapshot id and restored paths on every platform", () => {
    expect(snapshotId('{"message_type":"summary","snapshot_id":"abc"}')).toBe("abc");
    expect(snapshotId("not json")).toBeNull();
    expect(restoredPath("/tmp/r", "/data/hearth.dump", "linux")).toBe("/tmp/r/data/hearth.dump");
    expect(restoredPath("/tmp/r", "C:/Hearth/hearth.dump", "win32")).toBe(
      "/tmp/r/C/Hearth/hearth.dump",
    );
  });
});
