// Runs Jarvis: `hearth jarvis`, or `node apps/jarvis/src/main.ts`. Uses your Claude Code login
// (Claude Max), so turns cost nothing extra.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRINCIPAL } from "@hearth/core";
import { connect, databaseUrl } from "@hearth/db";
import { ClaudeBrain, startJarvis } from "@hearth/jarvis";
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

export async function runJarvis(): Promise<() => Promise<void>> {
  const database = connect(databaseUrl(), { max: 6 });
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
  const model = process.env.HEARTH_JARVIS_MODEL;
  const brain = new ClaudeBrain({
    ...(model
      ? { models: { fast: process.env.HEARTH_JARVIS_FAST_MODEL ?? model, deep: model } }
      : {}),
    web: process.env.HEARTH_JARVIS_WEB !== "0",
  });
  const service = await startJarvis({ kernel, pool: database.pool, brain });
  console.log("Jarvis is running: reacting to you and watching for things to handle.");
  const pidFile = writePidFile();
  return async () => {
    await service.stop();
    await database.close();
    if (pidFile) rmSync(pidFile, { force: true });
  };
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
  const stop = await runJarvis();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }
}
