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
import { watchForStopRequest } from "./stop-request.ts";

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
  let unwatch = () => {};
  // Once, whoever asks first: SIGTERM, a stop request, or both.
  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      unwatch();
      await service.stop();
      await database.close();
      if (pidFile) rmSync(pidFile, { force: true });
    })());
  unwatch = watchAsTask((why) => {
    log(`${why}, so Jarvis is stopping.`);
    // As SIGTERM would, then exit 0 however the stop went: the task starts Jarvis again a minute
    // after a failed exit, and one an update stopped must stay stopped while the code changes.
    const late = setTimeout(() => {
      log(`Still stopping after ${STOP_LIMIT_MS / 1000} s. Exiting anyway.`);
      process.exit(0);
    }, STOP_LIMIT_MS);
    late.unref();
    void stop()
      .catch((err) => log("stopping failed", err))
      .finally(() => {
        clearTimeout(late);
        process.exit(0);
      });
  });
  return stop;
}

/** Under the 15 seconds an update waits before it tries ending Jarvis itself (control.ps1). */
const STOP_LIMIT_MS = 12_000;

/** Hearth's services folder, where the task's Jarvis keeps its pid file; null when not the task. */
function servicesDir(): string | null {
  const dir = process.env.ProgramData;
  if (process.env.HEARTH_AS_SERVICE !== "1" || !dir) return null;
  return join(dir, "Hearth", "services");
}

/**
 * As the "Hearth Jarvis" task, stops when asked through hearth-jarvis.stop, or when the task run
 * that started it ends (stop-request.ts, D62). A request from before this process started was
 * for an earlier Jarvis.
 */
function watchAsTask(stop: (why: string) => void): () => void {
  const dir = servicesDir();
  if (!dir) return () => {};
  const file = join(dir, "hearth-jarvis.stop");
  return watchForStopRequest({ file, startedAt: performance.timeOrigin, stop, log });
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
 * As the "Hearth Jarvis" task, says which process is Jarvis, so ops/windows/control.ps1 knows
 * which one to wait for (and, elevated, to end): an unelevated account can't read the command
 * lines of the task's processes.
 */
function writePidFile(): string | null {
  const dir = servicesDir();
  if (!dir) return null;
  const file = join(dir, "hearth-jarvis.pid");
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
