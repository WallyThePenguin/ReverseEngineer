// /api/browser: pair the extension, see whether Chrome is connected, open it, the request
// endpoint Jarvis and the worker use to reach it, the link's log, and "Test Jarvis's Chrome".
// Only you and Hearth's own processes get in, except to the test page itself, which Chrome loads.
import type { IncomingMessage } from "node:http";
import { PRINCIPAL } from "@hearth/core";
import type { DbOrTx } from "@hearth/db";
import { ActionError, type Caller, getSetting, type Settings, setSetting } from "@hearth/kernel";
import {
  internalBrowserClient,
  reasonOf,
  runSelfTest,
  TEST_PAGE,
  TEST_PAGE_CSP,
} from "@hearth/modules";
import { Hono } from "hono";
import { z } from "zod";
import { requireCaller } from "../auth/middleware.ts";
import { hashToken, newToken } from "../auth/tokens.ts";
import type { AppEnv } from "../env.ts";
import type { BrowserBridge } from "./bridge.ts";

const Rpc = z.object({
  method: z.enum(["tabs.list", "tabs.open", "tabs.close", "tabs.release", "tabs.show", "cdp"]),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** You, or Hearth's own Jarvis and worker processes. Never MCP clients or integrations. */
function isInternal(caller: Caller): boolean {
  return (
    caller.kind === "owner" ||
    caller.principal === PRINCIPAL.jarvis ||
    caller.principal === PRINCIPAL.system
  );
}

/** How many earlier pairing codes Hearth remembers, to tell an old one from a wrong one. */
const OLD_PAIRINGS = 5;

/** Sets the pairing code, remembering the one it replaces. */
async function setPairing(db: DbOrTx, next: Settings["browser.pairing"]) {
  const current = await getSetting(db, "browser.pairing");
  if (current) {
    const old = await getSetting(db, "browser.oldPairings");
    await setSetting(db, "browser.oldPairings", [current.hash, ...old].slice(0, OLD_PAIRINGS));
  }
  await setSetting(db, "browser.pairing", next);
}

/**
 * Where this server can be reached from this PC: the address and port the request came in on, so
 * Chrome and Jarvis's client reach the very server that runs the test. Null when the request
 * didn't come over a socket (only in tests).
 */
function selfUrl(env: unknown): string | null {
  const socket = (env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket;
  const address = socket?.localAddress?.replace(/^::ffff:/, "");
  if (!address || !socket?.localPort) return null;
  const host = address === "::" || address === "0.0.0.0" ? "127.0.0.1" : address;
  return `http://${host.includes(":") ? `[${host}]` : host}:${socket.localPort}`;
}

export function browserRoutes(bridge: BrowserBridge) {
  const app = new Hono<AppEnv>();

  // The self-test's page, which Jarvis's Chrome tab loads without Hearth's sign-in.
  app.get("/test-page", (c) => {
    c.header("Content-Security-Policy", TEST_PAGE_CSP);
    c.header("Cache-Control", "no-store");
    return c.html(TEST_PAGE);
  });

  app.use("*", requireCaller());
  app.use("*", async (c, next) => {
    const caller = c.get("caller");
    if (!caller || !isInternal(caller)) return c.json({ error: "Not allowed." }, 403);
    await next();
  });

  app.get("/status", async (c) => {
    const pairing = await getSetting(c.get("deps").kernel.db, "browser.pairing");
    return c.json({ ...(await bridge.status()), paired: pairing !== null });
  });

  // What happened on the link lately, and how fast Chrome answers.
  app.get("/log", (c) => c.json({ entries: bridge.log.recent(100), stats: bridge.log.stats() }));

  // A new pairing code, shown once. Pairing again disconnects the old extension.
  app.post("/pair", requireCaller(["owner"]), async (c) => {
    const token = newToken();
    await setPairing(c.get("deps").kernel.db, {
      hash: hashToken(token),
      createdAt: new Date().toISOString(),
    });
    bridge.pairingChanged(true);
    return c.json({ token });
  });

  // You pressed Open Chrome: open it now, without waiting out an earlier failed try.
  app.post("/open", requireCaller(["owner"]), async (c) => {
    try {
      await bridge.open({ now: true });
      return c.json(bridge.snapshot());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
    }
  });

  app.delete("/pair", requireCaller(["owner"]), async (c) => {
    await setPairing(c.get("deps").kernel.db, null);
    bridge.pairingChanged(false);
    return c.json({ ok: true });
  });

  // "Test Jarvis's Chrome": a few steps as Jarvis, each one timed.
  app.post("/self-test", requireCaller(["owner"]), async (c) => {
    const { kernel } = c.get("deps");
    const base = selfUrl(c.env);
    if (!base) return c.json({ error: "Hearth couldn't tell its own address." }, 500);
    const jarvis = internalBrowserClient(kernel.db, PRINCIPAL.jarvis, base);
    return c.json(await runSelfTest(kernel, base, jarvis));
  });

  app.post("/rpc", async (c) => {
    const parsed = Rpc.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Bad browser request." }, 400);
    try {
      const result = await bridge.call(parsed.data.method, parsed.data.params);
      return c.json({ result: result ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof ActionError ? err.code : "failed";
      const reason = reasonOf(err);
      return c.json(
        { error: message, code, ...(reason ? { reason } : {}) },
        code === "unavailable" ? 503 : 502,
      );
    }
  });

  return app;
}
