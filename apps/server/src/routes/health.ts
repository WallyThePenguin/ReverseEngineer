// /api/health/deep: the full report (deep-health.ts). /api/health stays a bare "the server
// answers" for anything that only needs that (the desktop app, Tailscale, load checks).
//
// Deep health says which build runs and what's failing, so it isn't for everyone who can reach
// the server: you (signed in), Hearth's own tokens, or a program on this PC talking to it
// directly (ops/windows/update.ps1, `hearth doctor`). Tailscale Serve also connects from this
// PC, but it says whom it forwards for; a web page pointing its own name at 127.0.0.1 (DNS
// rebinding) is turned away by its Host header.
import type { IncomingMessage } from "node:http";
import { type Context, Hono } from "hono";
import type { ActionTimings } from "../action-timing.ts";
import type { BrowserBridge } from "../browser/bridge.ts";
import { isLoopback } from "../config.ts";
import { deepHealth } from "../deep-health.ts";
import type { AppEnv } from "../env.ts";
import { readVersionStamp } from "../version.ts";

/** A proxy's headers: Forwarded, X-Real-IP, and any X-Forwarded-* or Tailscale-* (D69). */
const proxyHeader = (h: string) =>
  h === "forwarded" ||
  h === "x-real-ip" ||
  h.startsWith("x-forwarded-") ||
  h.startsWith("tailscale-");

/** A request straight from a program on this PC, not through a proxy or a web page. */
export function directFromThisPc(c: Context<AppEnv>): boolean {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  const from = incoming?.socket?.remoteAddress?.replace(/^::ffff:/, "");
  if (!from || !isLoopback(from)) return false;
  if (Object.keys(c.req.header()).some(proxyHeader)) return false;
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return isLoopback(host);
}

export function healthRoutes(
  bridge: BrowserBridge,
  webDist: string | null,
  timings?: ActionTimings,
) {
  // Read once: the build this server started with.
  const version = readVersionStamp(webDist);
  const startedAt = new Date();
  const app = new Hono<AppEnv>();
  app.get("/deep", async (c) => {
    const caller = c.get("caller");
    const allowed = caller?.kind === "owner" || caller?.kind === "system" || directFromThisPc(c);
    if (!allowed) return c.json({ error: "Sign in first." }, 401);
    const { kernel } = c.get("deps");
    const report = await deepHealth({
      db: kernel.db,
      now: kernel.clock.now(),
      version,
      startedAt,
      browser: bridge.snapshot(),
      actions: timings?.slowest(),
    });
    // Always 200 when the server can answer: read `status`.
    c.header("Cache-Control", "no-store");
    return c.json(report);
  });
  return app;
}
