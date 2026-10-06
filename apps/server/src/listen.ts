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

/** The other loopback can't exist here (a machine or container without IPv6). */
const NO_SUCH_ADDRESS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

/**
 * Listens on `host`, and on the other loopback with it; any address it can't have fails the start,
 * so the service manager tries again. The one exception is a machine without IPv6, where [::1]
 * can't exist: Hearth works the same, only slower to open by "localhost". [::1] taken by another
 * program is a failure, not a skip: "localhost" would open that program instead of Hearth, while
 * everything that checks 127.0.0.1 saw Hearth healthy.
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
      const code = (e as NodeJS.ErrnoException).code;
      if (code && NO_SUCH_ADDRESS.has(code)) {
        console.warn(`No ${hostname} on this machine (${code}); "localhost" is slower to open.`);
        continue;
      }
      await closeAll(servers);
      const at = hostname.includes(":") ? `[${hostname}]` : hostname;
      throw Object.assign(
        new Error(
          `Something else has ${at}:${chosen} (${code ?? String(e)}), so "localhost" would open it instead of Hearth. Stop it, or give Hearth another port (HEARTH_PORT).`,
          { cause: e },
        ),
        { code },
      );
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
