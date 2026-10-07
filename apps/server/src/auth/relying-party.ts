// Which address a passkey request is for (D69). Passkeys belong to Hearth's own address, the one
// you open it at in a browser. The desktop app's window opens Hearth at http://localhost:<port>
// on this PC, where those can't work, so it has passkeys of its own, kept apart, that sign in only
// as that window.

import type { Context } from "hono";
import { localOriginOf, type ServerConfig } from "../config.ts";
import type { AppEnv } from "../env.ts";
import { directFromThisPc } from "../routes/health.ts";
import { type RelyingParty, relyingParty } from "./passkeys.ts";

let warned = false;

/** The window's address for passkeys, when it can have one. */
export function windowRelyingParty(
  config: Pick<ServerConfig, "origin" | "localOrigin" | "port">,
): RelyingParty | null {
  const local = new URL(localOriginOf(config));
  // Hearth's own address already, as in development: its passkeys work there as they are.
  if (local.origin === config.origin) return null;
  // A passkey's address is a name: 127.0.0.1 or [::1] can't have any.
  if (local.hostname !== "localhost") {
    if (!warned) {
      warned = true;
      console.warn(
        `[auth] The window on this PC can't have passkeys at ${local.origin}: they need a name. Set HEARTH_LOCAL_ORIGIN to http://localhost:${local.port || 80}.`,
      );
    }
    return null;
  }
  return { origin: local.origin, rpID: "localhost", local: true };
}

/**
 * The address a passkey request is for: the window's only when the request came straight from its
 * page. Its Origin isn't enough, since any program on this PC can send that, so it must also have
 * come to Hearth's address on this PC, from this PC, through no proxy. Tailscale Serve connects
 * from this PC too, but it adds X-Forwarded-Host and X-Forwarded-For and keeps your ts.net name as
 * the Host, so what comes through it is always for Hearth's own address.
 */
export function relyingPartyFor(c: Context<AppEnv>): RelyingParty {
  const { config } = c.get("deps");
  const local = windowRelyingParty(config);
  if (
    local &&
    c.req.header("origin") === local.origin &&
    c.req.header("host")?.toLowerCase() === new URL(local.origin).host &&
    directFromThisPc(c)
  )
    return local;
  return relyingParty(config.origin);
}
