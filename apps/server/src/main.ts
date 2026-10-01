// Runs the Hearth server: `hearth serve`, or `node apps/server/src/main.ts`.
import { connect, databaseUrl } from "@hearth/db";
import { Kernel, Registry } from "@hearth/kernel";
import { ALL_MODULES } from "@hearth/modules";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";

export async function runServer(): Promise<() => Promise<void>> {
  const config = loadServerConfig();
  const database = connect(databaseUrl());
  const kernel = new Kernel({ db: database.db, registry: new Registry(ALL_MODULES) });
  const server = createApp({ kernel, pool: database.pool, config });
  server.start();
  const http = serve({ fetch: server.app.fetch, hostname: config.host, port: config.port });
  console.log(
    `Hearth is listening on http://${config.host}:${config.port} (open ${config.origin})`,
  );
  if (config.devAuth) console.log("Development login is on: no passkey needed on this machine.");
  return async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await server.stop();
    await database.close();
  };
}

if (import.meta.main) {
  const stop = await runServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }
}
