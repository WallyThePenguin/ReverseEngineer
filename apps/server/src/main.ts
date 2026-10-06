// Runs the Hearth server: `hearth serve`, or `node apps/server/src/main.ts`.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect, databaseUrl } from "@hearth/db";
import { guardProcess, Kernel, Registry } from "@hearth/kernel";
import { ALL_MODULES } from "@hearth/modules";
import { createApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";
import { closeAll, listen } from "./listen.ts";

/** How long requests still running get to finish when Hearth stops. */
const STOP_GRACE_MS = 5_000;

export async function runServer(): Promise<() => Promise<void>> {
  const config = loadServerConfig();
  const database = connect(databaseUrl());
  const kernel = new Kernel({ db: database.db, registry: new Registry(ALL_MODULES) });
  const server = createApp({ kernel, pool: database.pool, config });
  // The addresses first: a server that can't have them must stop, with nothing of its own left
  // running (the event feed's database client, its timers), so the service manager starts it
  // again. Started first, those would keep a process up that answers nothing.
  let http: Server[];
  try {
    http = await listen(server.app.fetch, config.host, config.port);
  } catch (err) {
    await server.stop();
    await database.close();
    throw err;
  }
  server.start();
  server.attach(...http);
  const at = http.map((s) => {
    const { address } = s.address() as AddressInfo;
    return `http://${address.includes(":") ? `[${address}]` : address}:${config.port}`;
  });
  console.log(`Hearth is listening on ${at.join(" and ")} (open ${config.origin})`);
  if (config.devAuth) console.log("Development login is on: no passkey needed on this machine.");
  return async () => {
    // Take no new requests, then end the long-lived ones (the live view, the event feed, waits for
    // Chrome to open) so they don't hold up the stop. Requests still running get a few seconds.
    const closed = closeAll(http);
    await server.stop();
    // Connections left open between requests go as soon as they're idle.
    const idle = setInterval(() => {
      for (const s of http) s.closeIdleConnections();
    }, 100);
    const cutOff = setTimeout(() => {
      for (const s of http) s.closeAllConnections();
    }, STOP_GRACE_MS);
    await closed;
    clearInterval(idle);
    clearTimeout(cutOff);
    await database.close();
  };
}

if (import.meta.main) {
  guardProcess("server");
  const stop = await runServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }
}
