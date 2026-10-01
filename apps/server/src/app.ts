// The HTTP server: the action API, the live event feed, passkey login, /mcp and the web UI.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "@hearth/kernel";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type pg from "pg";
import { authenticate, sameOriginWrites } from "./auth/middleware.ts";
import type { ServerConfig } from "./config.ts";
import type { AppEnv, ServerDeps } from "./env.ts";
import { EventHub } from "./hub.ts";
import { mcpRoutes } from "./mcp.ts";
import { actionRoutes } from "./routes/actions.ts";
import { authRoutes } from "./routes/auth.ts";
import { eventRoutes } from "./routes/events.ts";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export interface AppOptions {
  kernel: Kernel;
  /** The pool used to LISTEN for events. Optional in tests, which call hub.publish instead. */
  pool?: pg.Pool | null;
  config: ServerConfig;
}

export function createApp(opts: AppOptions) {
  const hub = new EventHub(opts.pool ?? null);
  const deps: ServerDeps = {
    kernel: opts.kernel,
    pool: opts.pool as pg.Pool,
    config: opts.config,
    hub,
  };
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.use("/api/*", authenticate());
  app.use("/mcp", authenticate());
  app.use("/api/*", sameOriginWrites());
  app.route("/api/auth", authRoutes());
  app.route("/api/events", eventRoutes());
  app.route("/api", actionRoutes());
  app.route("/mcp", mcpRoutes());
  app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

  const dist = opts.config.webDist;
  if (dist && existsSync(join(dist, "index.html"))) {
    const index = readFileSync(join(dist, "index.html"), "utf8");
    app.use("/*", serveStatic({ root: dist }));
    // Client-side routes (/tasks/12, /notes/...) all load the app shell.
    app.get("*", (c) => c.html(index));
  } else {
    app.get("/", (c) =>
      c.text("Hearth's server is running. Build the web app (pnpm build:web) to use it here."),
    );
  }

  return {
    app,
    hub,
    start: () => hub.start(),
    stop: () => hub.stop(),
  };
}
