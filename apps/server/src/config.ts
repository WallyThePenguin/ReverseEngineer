// Server settings from the environment. Hearth listens on loopback by default; Tailscale Serve
// puts it on your tailnet over HTTPS.
import { type LaunchConfig, loadLaunchConfig } from "./browser/launch.ts";

export interface ServerConfig {
  host: string;
  port: number;
  /** The address you open Hearth at, e.g. https://pc.your-tailnet.ts.net. Passkeys are bound to it. */
  origin: string;
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
    devAuth,
    webDist: env.HEARTH_WEB_DIST ?? null,
    chrome: loadLaunchConfig(env),
  };
}
