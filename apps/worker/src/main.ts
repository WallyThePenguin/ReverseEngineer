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
  httpSlackBot,
  INSTALL_SERVICE,
  inboundStore,
  installFromEnv,
  internalBrowserClient,
  SLACK_BOT_SERVICE,
  SLACK_SERVICE,
  VAULT_SERVICE,
  vaultFromEnv,
} from "@hearth/modules";
import { startWorker } from "./worker.ts";

export async function runWorker(): Promise<() => Promise<void>> {
  const database = connect(databaseUrl(), { max: 4 });
  // Jarvis's Slack socket stores what it hears on a connection of its own, so a sync holding the
  // pool can't keep Slack waiting for its ack (D62).
  const slackInbound = inboundStore(databaseUrl());
  const kernel = new Kernel({
    db: database.db,
    registry: new Registry(ALL_MODULES),
    services: {
      [BROWSER_SERVICE]: internalBrowserClient(database.db, PRINCIPAL.system),
      // With the database, its pacing and tokens are shared with the server and Jarvis (D55).
      [GOOGLE_SERVICE]: googleFromEnv(database.db),
      [VAULT_SERVICE]: vaultFromEnv(),
      [SLACK_SERVICE]: httpSlack(),
      // The worker is the one process that opens Jarvis's bot and app tokens, and only on the
      // install that connected them (D62).
      [SLACK_BOT_SERVICE]: httpSlackBot(),
      [INSTALL_SERVICE]: installFromEnv(),
      [GITHUB_SERVICE]: httpGithub(),
      [BLOB_SERVICE]: blobsFromEnv(),
    },
  });
  const worker = startWorker({
    kernel,
    dataDir: process.env.HEARTH_DATA_DIR ?? process.cwd(),
    slackInbound,
  });
  console.log("Hearth worker running: schedules and health checks.");
  return async () => {
    worker.stop();
    await slackInbound.close();
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
