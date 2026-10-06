// Hearth on this PC answers "localhost" at once: on 127.0.0.1 and [::1], never the network.
import type { Server } from "node:http";
import { createServer } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeAll, listen, listenAddresses } from "./listen.ts";

const fetchHi = () => new Response("hi");
let open: Server[] = [];
afterEach(async () => {
  for (const s of open) s.closeAllConnections();
  await closeAll(open);
  open = [];
});

/** Some machines (a container) have no IPv6 loopback at all. */
let ipv6 = false;
beforeAll(async () => {
  ipv6 = await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
});

describe("listenAddresses", () => {
  it("is both loopbacks for this PC, the configured one first", () => {
    expect(listenAddresses("127.0.0.1")).toEqual(["127.0.0.1", "::1"]);
    expect(listenAddresses("localhost")).toEqual(["127.0.0.1", "::1"]);
    expect(listenAddresses("::1")).toEqual(["::1", "127.0.0.1"]);
  });

  it("is only the address given for anything else, never every address", () => {
    expect(listenAddresses("100.101.102.103")).toEqual(["100.101.102.103"]);
    expect(listenAddresses("0.0.0.0")).toEqual(["0.0.0.0"]);
  });
});

describe("listen", () => {
  it("answers on 127.0.0.1 and on [::1] at the same port", async () => {
    open = await listen(fetchHi, "127.0.0.1", 0);
    const port = (open[0]?.address() as { port: number } | undefined)?.port;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("hi");
    if (!ipv6) return expect(open).toHaveLength(1);
    expect(open).toHaveLength(2);
    expect(await (await fetch(`http://[::1]:${port}/`)).text()).toBe("hi");
  });

  it("won't start when another program has [::1]: localhost would open that instead", async () => {
    if (!ipv6) return;
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "::1", r));
    const { port } = blocker.address() as { port: number };
    try {
      await expect(listen(fetchHi, "127.0.0.1", port)).rejects.toMatchObject({
        code: "EADDRINUSE",
        message: expect.stringContaining(`[::1]:${port}`),
      });
      // And 127.0.0.1 is let go, for the next try.
      const again = createServer();
      await new Promise<void>((resolve, reject) => {
        again.once("error", reject);
        again.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((r) => again.close(() => r()));
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it("fails when the configured address can't be had", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const { port } = blocker.address() as { port: number };
    try {
      await expect(listen(fetchHi, "127.0.0.1", port)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
