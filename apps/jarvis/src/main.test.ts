import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { getSetting } from "@hearth/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runJarvis } from "./main.ts";

let dataDir: string;
const KEYS = [
  "HEARTH_DATABASE_URL",
  "HEARTH_DATA_DIR",
  "ProgramData",
  "HEARTH_AS_SERVICE",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hearth-jarvis-"));
  process.env.HEARTH_DATA_DIR = dataDir;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A database that lets Jarvis connect and never answers a query, so Jarvis stays starting. */
async function silentDatabase() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    // AuthenticationOk, then ReadyForQuery: connected, and nothing more, ever.
    const ready = [0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49];
    socket.once("data", () => socket.write(Buffer.from(ready)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgres://hearth@127.0.0.1:${port}/starting`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

describe("the Jarvis process", () => {
  it("fails to start with the error, rather than running half set up", async () => {
    // Nothing listens on port 1.
    process.env.HEARTH_DATABASE_URL = "postgres://hearth@127.0.0.1:1/nothing";
    await expect(runJarvis({ ownProcess: false })).rejects.toThrow();
  });

  // On a busy PC Jarvis took two minutes to start, longer than an update waits for it to stop.
  it("stops when asked while it's still starting, as the task", async () => {
    const database = await silentDatabase();
    process.env.HEARTH_DATABASE_URL = database.url;
    process.env.HEARTH_AS_SERVICE = "1";
    process.env.ProgramData = dataDir;
    const services = join(dataDir, "Hearth", "services");
    mkdirSync(services, { recursive: true });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const starting = runJarvis({ ownProcess: false }).catch(() => null);
    try {
      writeFileSync(join(services, "hearth-jarvis.stop"), new Date().toISOString());
      // Who wrote it is checked with PowerShell on Windows: give it time.
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 15_000 });
      expect(existsSync(join(services, "hearth-jarvis.pid"))).toBe(false);
      expect(existsSync(join(services, "hearth-jarvis.stop"))).toBe(false);
    } finally {
      database.close();
      // The start fails once the database has gone.
      expect(await starting).toBeNull();
    }
  }, 30_000);

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
        await vi.waitFor(
          async () => {
            expect(await getSetting(db.db, "jarvis.alive")).toMatchObject({ pid: process.pid });
          },
          { timeout: 10_000 },
        );
        expect(existsSync(join(dataDir, "jarvis"))).toBe(true);
      } finally {
        await stop();
      }
    });

    describe("and a services folder of its own", () => {
      // Never the real one (C:\ProgramData\Hearth\services): the live Jarvis's pid file is there.
      let services: string;
      let exit: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        process.env.ProgramData = dataDir;
        services = join(dataDir, "Hearth", "services");
        mkdirSync(services, { recursive: true });
        exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      });

      it("stops when asked through hearth-jarvis.stop, as the task", async () => {
        process.env.HEARTH_AS_SERVICE = "1";
        const stop = await runJarvis({ ownProcess: false });
        try {
          const pidFile = join(services, "hearth-jarvis.pid");
          expect(readFileSync(pidFile, "utf8")).toBe(String(process.pid));
          writeFileSync(join(services, "hearth-jarvis.stop"), new Date().toISOString());
          // Who wrote it is checked with PowerShell on Windows: give it time.
          await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 15_000 });
          // Stopped as SIGTERM stops it: the pid file is gone with the process, and the request
          // with it, so it can't stop the next Jarvis.
          expect(existsSync(pidFile)).toBe(false);
          expect(existsSync(join(services, "hearth-jarvis.stop"))).toBe(false);
        } finally {
          await stop();
        }
      }, 30_000);

      it("doesn't stop for hearth-jarvis.stop when it isn't the task", async () => {
        const stop = await runJarvis({ ownProcess: false });
        try {
          writeFileSync(join(services, "hearth-jarvis.stop"), new Date().toISOString());
          // It would look every second.
          await new Promise((r) => setTimeout(r, 2500));
          expect(exit).not.toHaveBeenCalled();
          expect(existsSync(join(services, "hearth-jarvis.pid"))).toBe(false);
        } finally {
          await stop();
        }
      });
    });
  });
});
