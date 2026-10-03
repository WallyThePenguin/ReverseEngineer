// The HTTP server: the action API, the live event feed, passkey login, /mcp, the browser bridge
// and the web UI.
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { getSetting, type Kernel } from "@hearth/kernel";
import {
  BLOB_SERVICE,
  BROWSER_SERVICE,
  blobsFromEnv,
  GOOGLE_SERVICE,
  googleFromEnv,
  POLISH_SERVICE,
  polisherFromEnv,
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
import { type PushSend, startPush, webPushSend } from "./push.ts";
import { actionRoutes } from "./routes/actions.ts";
import { authRoutes } from "./routes/auth.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { eventRoutes } from "./routes/events.ts";
import { googleRoutes } from "./routes/google.ts";
import { mailRoutes } from "./routes/mail.ts";
import { pushRoutes } from "./routes/push.ts";
import { voiceRoutes } from "./routes/voice.ts";

const CSP = [
  "default-src 'self'",
  // Docs run Loro, which is WebAssembly; this allows compiling it, not eval.
  "script-src 'self' 'wasm-unsafe-eval'",
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
  /** How phone notifications go out; tests pass a fake. */
  push?: PushSend;
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
  opts.kernel.services[BLOB_SERVICE] ??= blobsFromEnv();
  opts.kernel.services[POLISH_SERVICE] ??= polisherFromEnv();
  const live = new LiveView(bridge);
  const sendPush = opts.push ?? webPushSend;
  let push: ReturnType<typeof startPush> | null = null;
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
    // A route with its own policy (an email shown in a frame) keeps it.
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", CSP);
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
  app.route("/api/mail", mailRoutes());
  app.route("/api/devices", deviceRoutes());
  app.route("/api/voice", voiceRoutes());
  app.route("/api/push", pushRoutes(sendPush));
  app.route("/api", actionRoutes());
  app.route("/mcp", mcpRoutes());
  app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

  const dist = opts.config.webDist;
  if (dist && existsSync(join(dist, "index.html"))) {
    const index = readFileSync(join(dist, "index.html"), "utf8");
    // The service worker must update as soon as a new build is out.
    app.use("/sw.js", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-cache");
    });
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
    start: () => {
      hub.start();
      push = startPush(opts.kernel, hub, sendPush);
    },
    /** Resolves once phone notifications for the events so far are sent (for tests). */
    pushIdle: () => push?.idle() ?? Promise.resolve(),
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
      push?.stop();
      await hub.stop();
    },
  };
}
