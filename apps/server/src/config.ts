// Server settings from the environment. Hearth listens on loopback by default; Tailscale Serve
// puts it on your tailnet over HTTPS.
import { type LaunchConfig, loadLaunchConfig } from "./browser/launch.ts";

export interface ServerConfig {
  host: string;
  port: number;
  /** The address you open Hearth at, e.g. https://pc.your-tailnet.ts.net. Passkeys are bound to it. */
  origin: string;
  /**
   * Hearth's address on this PC, which the desktop app's window opens (D53): writes from it are
   * Hearth's own, and its session cookie works over plain http. Defaults to localhost:<port>.
   */
  localOrigin?: string;
  /** Skip login on loopback during development. Refused on any other address. */
  devAuth: boolean;
  /** Built web UI to serve, if any. */
  webDist: string | null;
  /** How Hearth opens your Chrome when Jarvis needs it (D28). */
  chrome: LaunchConfig;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/** Hearth's address on this PC (D53): HEARTH_LOCAL_ORIGIN, or http://localhost:<port>. */
export function localOriginOf(config: Pick<ServerConfig, "localOrigin" | "port">): string {
  return config.localOrigin ?? `http://localhost:${config.port}`;
}

/** Only an address on this PC can be the local one; anything else is ignored. */
function parseLocalOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if ((url.protocol === "http:" || url.protocol === "https:") && isLoopback(host))
      return url.origin;
  } catch {}
  console.warn(`HEARTH_LOCAL_ORIGIN must be an address on this PC, like http://localhost:4400.`);
  return undefined;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HEARTH_HOST ?? "127.0.0.1";
  const port = Number(env.HEARTH_PORT ?? 4400);
  const devAuth = env.HEARTH_DEV_AUTH === "1";
  if (devAuth && !isLoopback(host)) {
    throw new Error(
      "HEARTH_DEV_AUTH only works on a loopback address. Unset it or bind to 127.0.0.1.",
    );
  }
  return {
    host,
    port,
    origin: (env.HEARTH_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, ""),
    localOrigin: parseLocalOrigin(env.HEARTH_LOCAL_ORIGIN),
    devAuth,
    webDist: env.HEARTH_WEB_DIST ?? null,
    chrome: loadLaunchConfig(env),
  };
}
