// The HTTP server: the action API, the live event feed, passkey login, /mcp, the browser bridge
// and the web UI.
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import {
  DATABASE_DOWN,
  getSetting,
  isDatabaseDown,
  type Kernel,
  logLine,
  stackFrames,
} from "@hearth/kernel";
import {
  BLOB_SERVICE,
  BROWSER_SERVICE,
  blobsFromEnv,
  GITHUB_SERVICE,
  GOOGLE_SERVICE,
  googleFromEnv,
  httpGithub,
  httpSlack,
  POLISH_SERVICE,
  polisherFromEnv,
  SLACK_SERVICE,
  VAULT_SERVICE,
  vaultFromEnv,
} from "@hearth/modules";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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
import { healthRoutes } from "./routes/health.ts";
import { importRoutes } from "./routes/imports.ts";
import { mailRoutes } from "./routes/mail.ts";
import { pushRoutes } from "./routes/push.ts";
import { speechRoutes } from "./routes/speech.ts";
import { voiceRoutes } from "./routes/voice.ts";
import { SpeechRelay } from "./speech.ts";

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

const IMMUTABLE = "public, max-age=31536000, immutable";

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
  const speech = new SpeechRelay();
  const bridge =
    opts.bridge ??
    new BrowserBridge({
      launcher: createLauncher(opts.config.chrome),
      isPaired: async () => (await getSetting(opts.kernel.db, "browser.pairing")) !== null,
    });
  opts.kernel.services[BROWSER_SERVICE] ??= bridge;
  opts.kernel.services[GOOGLE_SERVICE] ??= googleFromEnv(opts.kernel.db);
  opts.kernel.services[VAULT_SERVICE] ??= vaultFromEnv();
  opts.kernel.services[SLACK_SERVICE] ??= httpSlack();
  opts.kernel.services[GITHUB_SERVICE] ??= httpGithub();
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
  // A request that throws gets a short JSON answer the app can show, never a stack trace or a
  // query's values. The database being out of reach is a 503 with a hint to try again soon.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const failed = `[server] ${c.req.method} ${c.req.path} failed: ${logLine(err)}`;
    if (isDatabaseDown(err)) {
      console.error(failed);
      c.header("Retry-After", "5");
      return c.json({ error: DATABASE_DOWN }, 503);
    }
    // A bug: where it happened is worth keeping.
    console.error(`${failed}${stackFrames(err)}`);
    return c.json({ error: "Something went wrong in Hearth. Try again in a moment." }, 500);
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.use("/api/*", authenticate());
  app.use("/mcp", authenticate());
  app.use("/api/*", sameOriginWrites());
  app.route("/api/health", healthRoutes(bridge, opts.config.webDist));
  app.route("/api/auth", authRoutes());
  app.route("/api/events", eventRoutes());
  app.route("/api/browser", browserRoutes(bridge));
  app.route("/api/google", googleRoutes());
  app.route("/api/mail", mailRoutes());
  app.route("/api/devices", deviceRoutes());
  app.route("/api/voice", speechRoutes(speech));
  app.route("/api/voice", voiceRoutes());
  app.route("/api/push", pushRoutes(sendPush));
  app.route("/api/import", importRoutes());
  app.route("/api", actionRoutes());
  app.route("/mcp", mcpRoutes());
  app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

  const dist = opts.config.webDist;
  if (dist && existsSync(join(dist, "index.html"))) {
    const index = readFileSync(join(dist, "index.html"), "utf8");
    // Built files have their content's hash in their name, so a copy is good forever. The page,
    // the service worker and the rest are checked each time, so a new build shows at once.
    app.use("/*", async (c, next) => {
      await next();
      const hashed =
        c.req.path.startsWith("/assets/") && (c.res.status === 200 || c.res.status === 206);
      c.header("Cache-Control", hashed ? IMMUTABLE : "no-cache");
    });
    // The build writes .br and .gz copies; the smallest the browser accepts is sent.
    app.use("/*", serveStatic({ root: dist, precompressed: true }));
    // A built file that isn't there (a page from an older build asking for its own) is missing,
    // not the app shell, which would load as broken JavaScript.
    app.get("/assets/*", (c) => c.text("Not found.", 404));
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
    speech,
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
