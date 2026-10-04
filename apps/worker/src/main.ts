// Runs the worker: `hearth worker`, or `node apps/worker/src/main.ts`.
import { PRINCIPAL } from "@hearth/core";
import { connect, databaseUrl } from "@hearth/db";
import { guardProcess, Kernel, Registry } from "@hearth/kernel";
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
import { startWorker } from "./worker.ts";

export async function runWorker(): Promise<() => Promise<void>> {
  const database = connect(databaseUrl(), { max: 4 });
  const kernel = new Kernel({
    db: database.db,
    registry: new Registry(ALL_MODULES),
    services: {
      [BROWSER_SERVICE]: internalBrowserClient(database.db, PRINCIPAL.system),
      // With the database, its pacing and tokens are shared with the server and Jarvis (D55).
      [GOOGLE_SERVICE]: googleFromEnv(database.db),
      [VAULT_SERVICE]: vaultFromEnv(),
      [SLACK_SERVICE]: httpSlack(),
      [GITHUB_SERVICE]: httpGithub(),
      [BLOB_SERVICE]: blobsFromEnv(),
    },
  });
  const worker = startWorker({ kernel, dataDir: process.env.HEARTH_DATA_DIR ?? process.cwd() });
  console.log("Hearth worker running: schedules and health checks.");
  return async () => {
    worker.stop();
    await database.close();
  };
}

if (import.meta.main) {
  guardProcess("worker");
  const stop = await runWorker();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }
}
