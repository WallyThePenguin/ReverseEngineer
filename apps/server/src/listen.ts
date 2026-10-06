// Where Hearth listens. On this PC only (loopback), on both 127.0.0.1 and [::1]: "localhost", the
// address the desktop app and your browser open, means ::1 first, and with nothing there every new
// connection waits about a quarter of a second before trying 127.0.0.1. Never "::" or 0.0.0.0,
// which would put Hearth on the network.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { isLoopback } from "./config.ts";

type Fetch = Parameters<typeof serve>[0]["fetch"];

/** The addresses to listen on: both loopbacks (the configured one first), or just the host. */
export function listenAddresses(host: string): string[] {
  if (!isLoopback(host)) return [host];
  return host === "::1" ? ["::1", "127.0.0.1"] : ["127.0.0.1", "::1"];
}

/**
 * Listens on `host`, and on the other loopback with it. The first address failing fails the start,
 * as it always has. The second one is skipped with a warning if it can't be had (no IPv6 on this
 * machine, or taken): Hearth still works, only slower to open by "localhost".
 */
export async function listen(fetch: Fetch, host: string, port: number): Promise<Server[]> {
  const [first = host, ...rest] = listenAddresses(host);
  const main = await start(fetch, first, port);
  // Port 0 (tests) picks a free one: the others share it.
  const chosen = (main.address() as AddressInfo).port;
  const servers = [main];
  for (const hostname of rest) {
    try {
      servers.push(await start(fetch, hostname, chosen));
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code ?? String(e);
      console.warn(`Hearth isn't listening on ${hostname} too (${why}); "localhost" is slower.`);
    }
  }
  return servers;
}

function start(fetch: Fetch, hostname: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, hostname, port }) as Server;
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** Stops taking requests on every address; resolves once the last one still running is done. */
export function closeAll(servers: Server[]): Promise<void> {
  return Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  ).then(() => {});
}
