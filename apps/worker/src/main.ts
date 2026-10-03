// Runs the worker: `hearth worker`, or `node apps/worker/src/main.ts`.
import { PRINCIPAL } from "@hearth/core";
import { connect, databaseUrl } from "@hearth/db";
import { Kernel, Registry } from "@hearth/kernel";
import {
  ALL_MODULES,
  BLOB_SERVICE,
  BROWSER_SERVICE,
  blobsFromEnv,
  GOOGLE_SERVICE,
  googleFromEnv,
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
      [GOOGLE_SERVICE]: googleFromEnv(),
      [VAULT_SERVICE]: vaultFromEnv(),
      [SLACK_SERVICE]: httpSlack(),
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
  const stop = await runWorker();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }
}
