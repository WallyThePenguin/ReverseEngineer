// The two WebSockets on Hearth's server: the extension's link (/api/browser/bridge), which
// proves itself with the pairing code, and the live view (/api/browser/live), which needs your
// signed-in browser session from Hearth's own page.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { PRINCIPAL } from "@hearth/core";
import { getSetting, type Kernel } from "@hearth/kernel";
import { type WebSocket, WebSocketServer } from "ws";
import { SESSION_COOKIE } from "../auth/middleware.ts";
import { hashToken, resolveToken, safeEqual } from "../auth/tokens.ts";
import { isLoopback, localOriginOf, type ServerConfig } from "../config.ts";
import type { BrowserBridge } from "./bridge.ts";
import type { LiveView } from "./live.ts";

export interface SocketDeps {
  kernel: Kernel;
  config: ServerConfig;
  bridge: BrowserBridge;
  live: LiveView;
}

function refuse(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function isOwnerPage(req: IncomingMessage, deps: SocketDeps): Promise<boolean> {
  // Same-origin only: a WebSocket isn't covered by the browser's CORS rules. With development
  // login on, the web app's dev server (another port on this PC) counts too.
  const origin = req.headers.origin ?? "";
  const devPage = deps.config.devAuth && isLoopback(hostOf(origin));
  const ours = origin === deps.config.origin || origin === localOriginOf(deps.config);
  if (!ours && !devPage) return false;
  const token = cookie(req, SESSION_COOKIE);
  const s = token ? await resolveToken(deps.kernel.db, token) : null;
  if (s) return s.principal === PRINCIPAL.owner && s.sessionKind === "browser";
  return deps.config.devAuth;
}

/** Waits for the extension's hello and checks its pairing code. */
function greet(ws: WebSocket, deps: SocketDeps): void {
  const timer = setTimeout(() => ws.close(4001, "No hello"), 10_000);
  ws.once("message", async (data) => {
    clearTimeout(timer);
    let hello: { type?: string; token?: string; version?: string };
    try {
      hello = JSON.parse(String(data));
    } catch {
      return ws.close(4001, "Bad hello");
    }
    const pairing = await getSetting(deps.kernel.db, "browser.pairing");
    const ok =
      hello.type === "hello" &&
      typeof hello.token === "string" &&
      pairing !== null &&
      safeEqual(pairing.hash, hashToken(hello.token));
    if (!ok) {
      // Only an earlier pairing code counts as an old one; anything can knock with a wrong code.
      const old = await getSetting(deps.kernel.db, "browser.oldPairings");
      const hash = typeof hello.token === "string" ? hashToken(hello.token) : "";
      if (hash && old.some((h) => safeEqual(h, hash))) deps.bridge.turnedAway();
      ws.send(
        JSON.stringify({
          type: "rejected",
          reason: "Hearth didn't accept that pairing code. Make a new one in Settings.",
        }),
      );
      return ws.close(4001, "Not paired");
    }
    deps.bridge.adopt(ws, String(hello.version ?? "?"));
  });
}

export function attachBrowserSockets(server: Server, deps: SocketDeps): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://hearth").pathname;
    if (path === "/api/browser/bridge") {
      // Only an extension may connect here, never a web page.
      if (!req.headers.origin?.startsWith("chrome-extension://"))
        return refuse(socket, "403 Forbidden");
      wss.handleUpgrade(req, socket, head, (ws) => greet(ws, deps));
      return;
    }
    if (path === "/api/browser/live") {
      void isOwnerPage(req, deps).then((ok) => {
        if (!ok) return refuse(socket, "401 Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => deps.live.connect(ws));
      });
      return;
    }
    refuse(socket, "404 Not Found");
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
