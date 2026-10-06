// `hearth serve` that can't start exits, so the service manager starts it again: a process that's
// up and answering nothing is never restarted.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { afterEach, expect, it } from "vitest";

let db: TestDatabase | null = null;
let blocker: Server | null = null;
let dir: string | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (blocker ? blocker.close(() => r()) : r()));
  await db?.destroy();
  if (dir) await rm(dir, { recursive: true, force: true });
  db = blocker = dir = null;
});

it("exits when the server can't have its port", async () => {
  db = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "hearth-serve-test-"));
  blocker = createServer();
  await new Promise<void>((r) => blocker?.listen(0, "127.0.0.1", r));
  const { port } = blocker.address() as { port: number };
  const cli = fileURLToPath(new URL("./main.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, "serve"], {
    cwd: dir,
    env: {
      ...process.env,
      HEARTH_DATABASE_URL: db.url,
      HEARTH_HOST: "127.0.0.1",
      HEARTH_PORT: String(port),
      HEARTH_DEV_AUTH: "",
      HEARTH_CHROME_LAUNCH: "off",
      HEARTH_DATA_DIR: dir,
    },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exit = await new Promise<number | "still running">((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("still running");
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
  expect(output).toContain("Hearth's serve couldn't start");
  expect(exit).toBe(1);
}, 60_000);
