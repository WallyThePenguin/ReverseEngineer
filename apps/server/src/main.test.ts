// A server that can't have its port gives up with nothing of its own left running, so its process
// ends and the service manager starts it again (instead of a process up and answering nothing).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Runs `code` in a fresh Node; resolves its exit code and output, or "still running" after `ms`. */
// 90 s: on a busy PC (CI shares the owner's), a fresh Node can take most of a minute just to import
// the server.
function runNode(code: string, env: NodeJS.ProcessEnv, cwd: string, ms = 90_000) {
  return new Promise<{ exit: number | "still running"; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env,
      cwd,
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exit: "still running", output });
    }, ms);
    child.on("exit", (exit) => {
      clearTimeout(timer);
      resolve({ exit: exit ?? -1, output });
    });
  });
}

it("gives up when its port is taken, leaving nothing running", async () => {
  db = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "hearth-main-test-"));
  blocker = createServer();
  await new Promise<void>((r) => blocker?.listen(0, "127.0.0.1", r));
  const { port } = blocker.address() as { port: number };
  const main = new URL("./main.ts", import.meta.url).href;
  // Caught, so the process ends only once nothing is left open: a database client or a timer
  // would keep it up until it's killed.
  const { exit, output } = await runNode(
    `import { runServer } from ${JSON.stringify(main)};
     try { await runServer(); } catch (e) { console.error("refused:", e.code); process.exitCode = 3; }`,
    {
      ...process.env,
      HEARTH_DATABASE_URL: db.url,
      HEARTH_HOST: "127.0.0.1",
      HEARTH_PORT: String(port),
      HEARTH_DEV_AUTH: "",
      HEARTH_CHROME_LAUNCH: "off",
      HEARTH_DATA_DIR: dir,
    },
    dir,
  );
  expect(exit, `still running after 90 s, having said: ${output || "nothing"}`).not.toBe(
    "still running",
  );
  expect(output).toContain("refused: EADDRINUSE");
  expect(exit).toBe(3);
}, 120_000);
