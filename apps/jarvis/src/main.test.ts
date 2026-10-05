import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { getSetting } from "@hearth/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRunning, runJarvis, whenParentEnds } from "./main.ts";

let dataDir: string;
const saved = { url: process.env.HEARTH_DATABASE_URL, dir: process.env.HEARTH_DATA_DIR };
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hearth-jarvis-"));
  process.env.HEARTH_DATA_DIR = dataDir;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const [key, value] of [
    ["HEARTH_DATABASE_URL", saved.url],
    ["HEARTH_DATA_DIR", saved.dir],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the Jarvis process", () => {
  it("fails to start with the error, rather than running half set up", async () => {
    // Nothing listens on port 1.
    process.env.HEARTH_DATABASE_URL = "postgres://hearth@127.0.0.1:1/nothing";
    await expect(runJarvis({ ownProcess: false })).rejects.toThrow();
  });

  describe("with a database", () => {
    let db: TestDatabase;
    beforeEach(async () => {
      db = await createTestDatabase();
      process.env.HEARTH_DATABASE_URL = db.url;
    });
    afterEach(() => db.destroy());

    it("starts, says it's alive, and keeps Claude's sessions in its own folder", async () => {
      const stop = await runJarvis({ ownProcess: false });
      try {
        await vi.waitFor(async () => {
          expect(await getSetting(db.db, "jarvis.alive")).toMatchObject({ pid: process.pid });
        });
        expect(existsSync(join(dataDir, "jarvis"))).toBe(true);
      } finally {
        await stop();
      }
    });
  });

  // As the "Hearth Jarvis" task: stopping the task ends the cmd Jarvis runs under, and only that.
  it("notices when the process it runs under has ended", async () => {
    const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
    const ended = new Promise((resolve) => parent.once("exit", resolve));
    const pid = parent.pid!;
    expect(isRunning(pid)).toBe(true);
    const gone = vi.fn();
    const unwatch = whenParentEnds(pid, gone, 50);
    try {
      expect(gone).not.toHaveBeenCalled();
      await ended;
      await vi.waitFor(() => expect(gone).toHaveBeenCalledOnce());
      expect(isRunning(pid)).toBe(false);
    } finally {
      unwatch();
    }
  });
});
