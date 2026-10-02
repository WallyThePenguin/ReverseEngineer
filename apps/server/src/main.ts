// Runs the Hearth server: `hearth serve`, or `node apps/server/src/main.ts`.

import type { Server } from "node:http";
import { connect, databaseUrl } from "@hearth/db";
import { Kernel, Registry } from "@hearth/kernel";
import { ALL_MODULES } from "@hearth/modules";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";

/** How long requests still running get to finish when Hearth stops. */
const STOP_GRACE_MS = 5_000;

export async function runServer(): Promise<() => Promise<void>> {
  const config = loadServerConfig();
  const database = connect(databaseUrl());
  const kernel = new Kernel({ db: database.db, registry: new Registry(ALL_MODULES) });
  const server = createApp({ kernel, pool: database.pool, config });
  server.start();
  const http = serve({
    fetch: server.app.fetch,
    hostname: config.host,
    port: config.port,
  }) as Server;
  server.attach(http);
  console.log(
    `Hearth is listening on http://${config.host}:${config.port} (open ${config.origin})`,
  );
  if (config.devAuth) console.log("Development login is on: no passkey needed on this machine.");
  return async () => {
    // Take no new requests, then end the long-lived ones (the live view, the event feed, waits for
    // Chrome to open) so they don't hold up the stop. Requests still running get a few seconds.
    const closed = new Promise<void>((resolve) => http.close(() => resolve()));
    await server.stop();
    // Connections left open between requests go as soon as they're idle.
    const idle = setInterval(() => http.closeIdleConnections(), 100);
    const cutOff = setTimeout(() => http.closeAllConnections(), STOP_GRACE_MS);
    await closed;
    clearInterval(idle);
    clearTimeout(cutOff);
    await database.close();
  };
}

if (import.meta.main) {
  const stop = await runServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }
}
