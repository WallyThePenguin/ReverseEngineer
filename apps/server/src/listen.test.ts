// Hearth on this PC answers "localhost" at once: on 127.0.0.1 and [::1], never the network.
import type { Server } from "node:http";
import { createServer } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAll, listen, listenAddresses } from "./listen.ts";

const fetchHi = () => new Response("hi");
let open: Server[] = [];
afterEach(async () => {
  for (const s of open) s.closeAllConnections();
  await closeAll(open);
  open = [];
  vi.restoreAllMocks();
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

  it("still starts when [::1] is taken, and says so", async () => {
    if (!ipv6) return;
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "::1", r));
    const { port } = blocker.address() as { port: number };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      open = await listen(fetchHi, "127.0.0.1", port);
      expect(open).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("EADDRINUSE"));
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
