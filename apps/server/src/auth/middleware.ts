// Works out who's calling: a browser session cookie, a bearer token, or (in development on
// loopback only) the owner without a login.

import type { Caller } from "@hearth/kernel";
import { ownerCaller } from "@hearth/kernel";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env.ts";
import { resolveToken, type SessionPrincipal } from "./tokens.ts";

export const SESSION_COOKIE = "hearth_session";

export function callerFor(s: SessionPrincipal): Caller {
  if (s.kind === "owner") return ownerCaller(s.sessionKind === "browser" ? "ui" : "cli");
  return {
    principal: s.principal,
    kind: s.kind,
    origin: s.kind === "system" ? "system" : "agent",
    via: s.kind === "mcp_client" ? "mcp" : s.kind === "integration" ? "integration" : "system",
  };
}

function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

export function authenticate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { kernel, config } = c.get("deps");
    c.set("caller", null);
    c.set("token", null);
    c.set("viaCookie", false);
    const token = bearer(c);
    if (token) {
      const s = await resolveToken(kernel.db, token);
      if (!s) return c.json({ error: "That token isn't valid." }, 401);
      c.set("caller", callerFor(s));
      c.set("token", token);
    } else {
      const cookie = getCookie(c, SESSION_COOKIE);
      const s = cookie ? await resolveToken(kernel.db, cookie) : null;
      if (s && s.sessionKind === "browser") {
        c.set("caller", callerFor(s));
        c.set("token", cookie ?? null);
        c.set("viaCookie", true);
      } else if (config.devAuth) {
        c.set("caller", ownerCaller("ui"));
        c.set("viaCookie", true);
      }
    }
    await next();
  };
}

/**
 * Cookie-authenticated writes must come from Hearth's own page. SameSite=Strict already blocks
 * most cross-site requests; this closes the rest.
 */
export function sameOriginWrites(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      const expected = c.get("deps").config.origin;
      const cookieAuthed = c.get("viaCookie") || !bearer(c);
      if (cookieAuthed && origin !== expected && site !== "same-origin") {
        return c.json({ error: "Cross-site request refused." }, 403);
      }
    }
    await next();
  };
}

export function requireCaller(kinds?: Caller["kind"][]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const caller = c.get("caller");
    if (!caller) return c.json({ error: "Sign in first." }, 401);
    if (kinds && !kinds.includes(caller.kind)) return c.json({ error: "Not allowed." }, 403);
    await next();
  };
}
