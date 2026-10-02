// /api/browser: pair the extension, see whether Chrome is connected, open it, and the request
// endpoint Jarvis and the worker use to reach it. Only you and Hearth's own processes get in.
import { PRINCIPAL } from "@hearth/core";
import { ActionError, type Caller, getSetting, setSetting } from "@hearth/kernel";
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

export function browserRoutes(bridge: BrowserBridge) {
  const app = new Hono<AppEnv>();
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

  // A new pairing code, shown once. Pairing again disconnects the old extension.
  app.post("/pair", requireCaller(["owner"]), async (c) => {
    const token = newToken();
    await setSetting(c.get("deps").kernel.db, "browser.pairing", {
      hash: hashToken(token),
      createdAt: new Date().toISOString(),
    });
    bridge.disconnect();
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
    await setSetting(c.get("deps").kernel.db, "browser.pairing", null);
    bridge.disconnect();
    return c.json({ ok: true });
  });

  app.post("/rpc", async (c) => {
    const parsed = Rpc.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Bad browser request." }, 400);
    try {
      const result = await bridge.call(parsed.data.method, parsed.data.params);
      return c.json({ result: result ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const offline = err instanceof ActionError && err.code === "unavailable";
      return c.json({ error: message }, offline ? 503 : 502);
    }
  });

  return app;
}
