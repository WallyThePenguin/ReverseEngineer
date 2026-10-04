// `hearth migrate` says what committed even when it fails: update.ps1 reverts exactly that.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateCommand } from "./migrate.ts";

let tdb: TestDatabase;
let dir: string;
beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "hearth-migrations-"));
  // Numbered after every real migration, as a later update's are; the second fails.
  await writeFile(join(dir, "9001_one.up.sql"), "CREATE TABLE seam_one (id int)");
  await writeFile(join(dir, "9001_one.down.sql"), "DROP TABLE seam_one");
  await writeFile(join(dir, "9002_bad.up.sql"), "SELECT * FROM no_such_table");
  await writeFile(join(dir, "9002_bad.down.sql"), "SELECT 1");
});
afterEach(async () => {
  await tdb.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe("hearth migrate", () => {
  it("prints what it applied before a migration failed, then fails", async () => {
    const lines: string[] = [];
    const log = (line: string) => void lines.push(line);
    await expect(migrateCommand(tdb.pool, [], log, dir)).rejects.toThrow(
      /^Migration 9002_bad failed/,
    );
    expect(lines).toEqual(["Applied: 9001_one"]);

    lines.length = 0;
    expect(await migrateCommand(tdb.pool, ["down", "9001_one"], log, dir)).toBe(0);
    expect(await migrateCommand(tdb.pool, ["down", "9001_one"], log, dir)).toBe(0);
    expect(lines).toEqual(["Reverted: 9001_one", "Nothing to revert."]);
  });
});
