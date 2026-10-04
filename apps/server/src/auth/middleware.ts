// Works out who's calling: a browser session cookie, a bearer token, or (in development on
// loopback only) the owner without a login.

import type { Caller } from "@hearth/kernel";
import { ownerCaller } from "@hearth/kernel";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { localOriginOf } from "../config.ts";
import type { AppEnv } from "../env.ts";
import { scopeAllows } from "./devices.ts";
import { checkToken, SESSION_DAYS, type SessionPrincipal, type TokenRefusal } from "./tokens.ts";

export const SESSION_COOKIE = "hearth_session";

/**
 * Cookies are Secure when Hearth is on https, except on its plain-http address on this PC, which
 * the desktop app's window opens (D53): there a Secure cookie would never come back.
 */
export function secureCookies(c: Context<AppEnv>): boolean {
  const { config } = c.get("deps");
  if (!config.origin.startsWith("https://")) return false;
  const local = new URL(localOriginOf(config));
  if (local.protocol === "https:") return true;
  const host = c.req.header("host") ?? new URL(c.req.url).host;
  return host.toLowerCase() !== local.host;
}

/** The sign-in cookie, as routes/auth.ts sets it at sign-in, for a session that just slid. */
function renewCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secureCookies(c),
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

const lastLogged = new Map<string, number>();
/** Says why a token was turned away, once a minute per reason, so a stale tab can't flood it. */
function logRefusal(how: "cookie" | "bearer token", reason: TokenRefusal, path: string) {
  const key = `${how}:${reason}`;
  const now = Date.now();
  if ((lastLogged.get(key) ?? 0) > now - 60_000) return;
  lastLogged.set(key, now);
  console.warn(`[auth] ${how} refused (${reason}) on ${path}`);
}

export function callerFor(s: SessionPrincipal): Caller {
  // A paired device acts as you, but what it starts is held to the rules for outside content:
  // Jarvis asks before changing your accounts or acting for you on its say-so (D42).
  if (s.kind === "owner" && s.scopes) return ownerCaller("device", { origin: "untrusted" });
  if (s.kind === "owner") return ownerCaller(s.sessionKind === "browser" ? "ui" : "cli");
  // An outside agent or integration writes outside content: what it adds lowers the trust of
  // whatever reads it, and it can't leave standing instructions (D58).
  const outside = s.kind === "mcp_client" || s.kind === "integration";
  return {
    principal: s.principal,
    kind: s.kind,
    origin: s.kind === "system" ? "system" : outside ? "untrusted" : "agent",
    via: s.kind === "mcp_client" ? "mcp" : s.kind === "integration" ? "integration" : "system",
  };
}

function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/**
 * Checks the page makes by itself in the background, like the update notice asking which build
 * runs every few minutes (D57). They don't count as using a sign-in, or every open tab would keep
 * its sign-in alive forever (D56).
 */
const NOT_A_USE = new Set(["/api/health/deep"]);

export function authenticate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { kernel, config } = c.get("deps");
    c.set("caller", null);
    c.set("token", null);
    c.set("viaCookie", false);
    const token = bearer(c);
    if (token) {
      const r = await checkToken(kernel.db, token);
      if (!r.ok) {
        logRefusal("bearer token", r.reason, c.req.path);
        return c.json({ error: "That token isn't valid." }, 401);
      }
      const s = r.session;
      if (s.scopes && !scopeAllows(s.scopes, c.req.method, c.req.path))
        return c.json({ error: "This device's token can't do that." }, 403);
      c.set("caller", callerFor(s));
      c.set("token", token);
    } else {
      const cookie = getCookie(c, SESSION_COOKIE);
      const touch = !NOT_A_USE.has(c.req.path);
      const r = cookie ? await checkToken(kernel.db, cookie, undefined, { touch }) : null;
      if (r && !r.ok) logRefusal("cookie", r.reason, c.req.path);
      if (cookie && r?.ok && r.session.sessionKind === "browser") {
        c.set("caller", callerFor(r.session));
        c.set("token", cookie);
        c.set("viaCookie", true);
        if (r.extendedUntil) renewCookie(c, cookie);
      } else if (config.devAuth) {
        c.set("caller", ownerCaller("ui"));
        c.set("viaCookie", true);
      }
    }
    await next();
  };
}

/**
 * Writes that use no session at all and carry their own proof: the desktop app trading the
 * one-time nonce from a connect link (D53). The app isn't a web page, so it sends no Origin.
 */
const SELF_PROVING_WRITES = new Set(["/api/auth/desktop/redeem"]);

/**
 * Cookie-authenticated writes must come from Hearth's own page: at its address, or at its address
 * on this PC (the desktop app's window, D53). SameSite=Strict already blocks most cross-site
 * requests; this closes the rest.
 */
export function sameOriginWrites(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      method !== "OPTIONS" &&
      !SELF_PROVING_WRITES.has(c.req.path)
    ) {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      const { config } = c.get("deps");
      const ours = origin === config.origin || origin === localOriginOf(config);
      const cookieAuthed = c.get("viaCookie") || !bearer(c);
      if (cookieAuthed && !ours && site !== "same-origin") {
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
