// Runs Jarvis: `hearth jarvis`, or `node apps/jarvis/src/main.ts`. Uses your Claude Code login
// (Claude Max), so turns cost nothing extra.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRINCIPAL } from "@hearth/core";
import { connect, databaseUrl } from "@hearth/db";
import { ClaudeBrain, fileTurnLog, startJarvis } from "@hearth/jarvis";
import { Kernel, Registry } from "@hearth/kernel";
import {
  ALL_MODULES,
  BLOB_SERVICE,
  BROWSER_SERVICE,
  blobsFromEnv,
  GITHUB_SERVICE,
  GOOGLE_SERVICE,
  googleFromEnv,
  httpGithub,
  httpSlack,
  internalBrowserClient,
  SLACK_SERVICE,
  VAULT_SERVICE,
  vaultFromEnv,
} from "@hearth/modules";

/** A log line with the time, so hearth-jarvis.log says when things happened. */
function log(msg: string, err?: unknown): void {
  const detail =
    err === undefined
      ? ""
      : ` ${err instanceof Error ? (err.stack ?? err.message) : JSON.stringify(err)}`;
  console.error(`${new Date().toISOString()} [jarvis] ${msg}${detail}`);
}

export interface RunJarvisOptions {
  /**
   * Jarvis is its own process (the "Hearth Jarvis" task): a failed start or a crash ends it with
   * an error, so it's started again, rather than leaving it half alive (D54). Off when Jarvis
   * shares a process with the server (`hearth dev`).
   */
  ownProcess?: boolean;
}

export async function runJarvis(opts: RunJarvisOptions = {}): Promise<() => Promise<void>> {
  const ownProcess = opts.ownProcess ?? process.env.HEARTH_AS_SERVICE === "1";
  if (ownProcess) watchForCrashes();
  const database = connect(databaseUrl(), { max: 6 });
  const dataDir = process.env.HEARTH_DATA_DIR ?? process.cwd();
  let service: Awaited<ReturnType<typeof startJarvis>>;
  try {
    const kernel = new Kernel({
      db: database.db,
      registry: new Registry(ALL_MODULES),
      // Chrome is reached through the server, which holds the extension's connection.
      services: {
        [BROWSER_SERVICE]: internalBrowserClient(database.db, PRINCIPAL.jarvis),
        // With the database, its pacing and tokens are shared with the server and worker (D55).
        [GOOGLE_SERVICE]: googleFromEnv(database.db),
        [VAULT_SERVICE]: vaultFromEnv(),
        [SLACK_SERVICE]: httpSlack(),
        [GITHUB_SERVICE]: httpGithub(),
        [BLOB_SERVICE]: blobsFromEnv(),
      },
    });
    // Claude keeps its sessions per folder: a fixed one lets conversations resume after an
    // update or a move (D54).
    const cwd = join(dataDir, "jarvis");
    mkdirSync(cwd, { recursive: true });
    const brain = new ClaudeBrain({
      // Sonnet answers quickly; Opus does the deep work (D54).
      models: {
        fast: process.env.HEARTH_JARVIS_FAST_MODEL ?? "sonnet",
        deep: process.env.HEARTH_JARVIS_MODEL ?? "opus",
      },
      web: process.env.HEARTH_JARVIS_WEB !== "0",
      cwd,
    });
    const turnLog = fileTurnLog(join(dataDir, "logs", "jarvis-turns.jsonl"), {
      onError: (err) => log("couldn't write the turn log", err),
    });
    service = await startJarvis({ kernel, pool: database.pool, brain, log, runner: { turnLog } });
  } catch (err) {
    log("Jarvis couldn't start", err);
    await database.close().catch(() => {});
    if (ownProcess) {
      process.exitCode = 1;
      // Whatever still holds the process open, it ends, so the task can start it again.
      setTimeout(() => process.exit(1), 5000).unref();
    }
    throw err;
  }
  log("Jarvis is running: reacting to you and watching for things to handle.");
  const pidFile = writePidFile();
  const unwatch = asTask() ? whenParentEnds(process.ppid, stopWithTask) : () => {};
  return async () => {
    unwatch();
    await service.stop();
    await database.close();
    if (pidFile) rmSync(pidFile, { force: true });
  };
}

/** Jarvis as the "Hearth Jarvis" task (install.ps1), under the cmd that writes its log. */
const asTask = () => process.env.HEARTH_AS_SERVICE === "1" && process.platform === "win32";

/** Whether process `pid` is running. One this account may not signal is still running. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Calls `onGone` once process `parent` has ended. As the task, Jarvis runs under cmd (for its
 * log), and stopping the task ends cmd only. Your own account, which stops it for updates and
 * restarts, can't end Jarvis itself: it runs in the task's logon session, where an unelevated
 * account may not open it. A Jarvis left running keeps the old code going and holds its log
 * open, and while it does, every start of the task fails on that log.
 */
export function whenParentEnds(parent: number, onGone: () => void, everyMs = 2000): () => void {
  const timer = setInterval(() => {
    if (isRunning(parent)) return;
    clearInterval(timer);
    onGone();
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Its task was stopped: stop as if asked to (SIGTERM), and in any case within 20 seconds. */
function stopWithTask(): void {
  log("Its task was stopped, so Jarvis is stopping.");
  setTimeout(() => process.exit(0), 20_000).unref();
  process.emit("SIGTERM", "SIGTERM");
}

let watching = false;

/** A stray rejected promise is logged and Jarvis carries on; a thrown error ends the process. */
function watchForCrashes(): void {
  if (watching) return;
  watching = true;
  process.on("unhandledRejection", (reason) => log("unhandled rejection", reason));
  process.on("uncaughtException", (err) => {
    log("Jarvis crashed", err);
    process.exit(1);
  });
}

/**
 * As the "Hearth Jarvis" task, says which process is Jarvis, so ops/windows/update.ps1 can stop
 * it: an unelevated account can't read the command lines of the task's processes.
 */
function writePidFile(): string | null {
  const dir = process.env.ProgramData;
  if (process.env.HEARTH_AS_SERVICE !== "1" || !dir) return null;
  const file = join(dir, "Hearth", "services", "hearth-jarvis.pid");
  try {
    writeFileSync(file, String(process.pid));
    return file;
  } catch (err) {
    console.error(`Couldn't write ${file}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

if (import.meta.main) {
  const stop = await runJarvis({ ownProcess: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }
}
