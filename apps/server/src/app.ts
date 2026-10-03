// The HTTP server: the action API, the live event feed, passkey login, /mcp, the browser bridge
// and the web UI.
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { getSetting, type Kernel } from "@hearth/kernel";
import {
  BROWSER_SERVICE,
  GOOGLE_SERVICE,
  googleFromEnv,
  VAULT_SERVICE,
  vaultFromEnv,
} from "@hearth/modules";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type pg from "pg";
import { authenticate, sameOriginWrites } from "./auth/middleware.ts";
import { BrowserBridge } from "./browser/bridge.ts";
import { createLauncher } from "./browser/launch.ts";
import { LiveView } from "./browser/live.ts";
import { browserRoutes } from "./browser/routes.ts";
import { attachBrowserSockets } from "./browser/sockets.ts";
import type { ServerConfig } from "./config.ts";
import type { AppEnv, ServerDeps } from "./env.ts";
import { EventHub } from "./hub.ts";
import { mcpRoutes } from "./mcp.ts";
import { actionRoutes } from "./routes/actions.ts";
import { authRoutes } from "./routes/auth.ts";
import { eventRoutes } from "./routes/events.ts";
import { googleRoutes } from "./routes/google.ts";

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
  /** The extension's link. The kernel's browser service is set to it if it has none. */
  bridge?: BrowserBridge;
}

export function createApp(opts: AppOptions) {
  const hub = new EventHub(opts.pool ?? null);
  const bridge =
    opts.bridge ??
    new BrowserBridge({
      launcher: createLauncher(opts.config.chrome),
      isPaired: async () => (await getSetting(opts.kernel.db, "browser.pairing")) !== null,
    });
  opts.kernel.services[BROWSER_SERVICE] ??= bridge;
  opts.kernel.services[GOOGLE_SERVICE] ??= googleFromEnv();
  opts.kernel.services[VAULT_SERVICE] ??= vaultFromEnv();
  const live = new LiveView(bridge);
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
  app.route("/api/browser", browserRoutes(bridge));
  app.route("/api/google", googleRoutes());
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

  let detachSockets: (() => void) | null = null;
  return {
    app,
    hub,
    bridge,
    start: () => hub.start(),
    /** Adds the WebSockets (the extension's link and the live view) to the HTTP server. */
    attach(server: Server) {
      detachSockets = attachBrowserSockets(server, {
        kernel: opts.kernel,
        config: opts.config,
        bridge,
        live,
      });
    },
    async stop() {
      detachSockets?.();
      bridge.close();
      await hub.stop();
    },
  };
}
