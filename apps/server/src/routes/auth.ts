// Sign-in with passkeys. The first passkey is added with the setup code `hearth setup` prints;
// after that, new passkeys can only be added from a signed-in session. The desktop app's window
// signs in by hand-off from a signed-in browser instead (D53, /desktop/* below).

import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { DESKTOP_WINDOW, pairDevice, revokeDesktopWindow } from "../auth/devices.ts";
import { type Handoffs, handoffs as sharedHandoffs } from "../auth/handoff.ts";
import { SESSION_COOKIE, secureCookies } from "../auth/middleware.ts";
import {
  checkSetupCode,
  hasPasskey,
  loginOptions,
  registrationOptions,
  relyingParty,
  verifyLogin,
  verifyRegistration,
} from "../auth/passkeys.ts";
import { createSession, revokeToken } from "../auth/tokens.ts";
import type { AppEnv } from "../env.ts";

const CHALLENGE_COOKIE = "hearth_challenge";
const SESSION_DAYS = 30;

const registerOptionsBody = z.object({ setupCode: z.string().max(40).optional() });
const verifyBody = z.object({
  // The browser's WebAuthn response; SimpleWebAuthn checks its shape.
  response: z.record(z.string(), z.unknown()),
  label: z.string().max(100).optional(),
  setupCode: z.string().max(40).optional(),
});

function setChallenge(c: Context<AppEnv>, id: string) {
  setCookie(c, CHALLENGE_COOKIE, id, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secureCookies(c),
    path: "/api/auth",
    maxAge: 300,
  });
}

function takeChallengeCookie(c: Context<AppEnv>): string | null {
  const id = getCookie(c, CHALLENGE_COOKIE) ?? null;
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/api/auth" });
  return id;
}

async function signIn(c: Context<AppEnv>, principal: string, label?: string) {
  const { kernel } = c.get("deps");
  const token = await createSession(kernel.db, {
    principal,
    kind: "browser",
    label: label ?? c.req.header("user-agent")?.slice(0, 120) ?? "browser",
    ttlDays: SESSION_DAYS,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secureCookies(c),
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

/** You may add a passkey if you're signed in, or if none exists yet and you have the setup code. */
async function mayRegister(c: Context<AppEnv>, setupCode: string | undefined): Promise<boolean> {
  const { kernel } = c.get("deps");
  if (c.get("caller")?.kind === "owner") return true;
  if (await hasPasskey(kernel.db)) return false;
  return !!setupCode && (await checkSetupCode(kernel.db, setupCode));
}

const redeemBody = z.object({ nonce: z.string().min(16).max(128) });

const RUN_OUT_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect again</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>That sign-in link has run out</h1>
<p>In Hearth in your browser, open Settings, then Desktop app, and choose
<b>Connect Hearth on this PC</b> again.</p></body></html>`;

export function authRoutes(handoffs: Handoffs = sharedHandoffs) {
  const app = new Hono<AppEnv>();

  // The desktop app's sign-in hand-off (D53, auth/handoff.ts). Signed in in your browser, you
  // ask for a connect link. Only that: a device's token can't, so it can never become a session.
  app.post("/desktop/handoff", (c) => {
    const caller = c.get("caller");
    if (!c.get("viaCookie") || caller?.kind !== "owner" || caller.via !== "ui")
      return c.json({ error: "Sign in to Hearth in your browser first." }, 403);
    const nonce = handoffs.nonces.issue(caller.principal);
    c.header("Cache-Control", "no-store");
    return c.json({ nonce, link: `hearth://connect?nonce=${nonce}`, expiresInSeconds: 60 });
  });

  // The app trades the nonce for its device token and a code for its window. It's paired anew,
  // so its token has today's scopes.
  app.post("/desktop/redeem", async (c) => {
    const body = redeemBody.safeParse(await c.req.json().catch(() => null));
    const principal = body.success ? handoffs.nonces.take(body.data.nonce) : null;
    if (!principal) return c.json({ error: "That connect link has run out or was used." }, 410);
    const token = await pairDevice(c.get("deps").kernel.db, "desktop");
    c.header("Cache-Control", "no-store");
    return c.json({ token, code: handoffs.codes.issue(principal) });
  });

  // The app's window trades the code for an ordinary session, then opens Today. It has one
  // such session: connecting again signs the last one out, and so does disconnecting the app.
  app.get("/desktop/window", async (c) => {
    const principal = handoffs.codes.take(c.req.query("code"));
    c.header("Cache-Control", "no-store");
    if (!principal) return c.html(RUN_OUT_PAGE, 410);
    await revokeDesktopWindow(c.get("deps").kernel.db);
    await signIn(c, principal, DESKTOP_WINDOW);
    return c.redirect("/today", 302);
  });

  app.get("/me", async (c) => {
    const { kernel } = c.get("deps");
    const caller = c.get("caller");
    return c.json({
      signedIn: !!caller,
      principal: caller?.principal ?? null,
      kind: caller?.kind ?? null,
      needsSetup: !(await hasPasskey(kernel.db)),
    });
  });

  app.post("/register/options", async (c) => {
    const { kernel, config } = c.get("deps");
    const body = registerOptionsBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success || !(await mayRegister(c, body.data.setupCode))) {
      return c.json({ error: "Sign in, or use the setup code from `hearth setup`." }, 403);
    }
    const { options, challengeId } = await registrationOptions(
      kernel.db,
      relyingParty(config.origin),
    );
    setChallenge(c, challengeId);
    return c.json(options);
  });

  app.post("/register/verify", async (c) => {
    const { kernel, config } = c.get("deps");
    const body = verifyBody.safeParse(await c.req.json().catch(() => null));
    const challengeId = takeChallengeCookie(c);
    if (!body.success || !challengeId) return c.json({ error: "Start again." }, 400);
    const first = c.get("caller")?.kind !== "owner";
    if (!(await mayRegister(c, body.data.setupCode))) return c.json({ error: "Not allowed." }, 403);
    const ok = await verifyRegistration(
      kernel.db,
      relyingParty(config.origin),
      challengeId,
      body.data.response as never,
      body.data.label ?? "Passkey",
    ).catch(() => false);
    if (!ok) return c.json({ error: "That passkey couldn't be verified." }, 400);
    if (first) await signIn(c, "owner");
    return c.json({ ok: true });
  });

  app.post("/login/options", async (c) => {
    const { kernel, config } = c.get("deps");
    if (!(await hasPasskey(kernel.db)))
      return c.json({ error: "No passkey yet. Run `hearth setup`." }, 409);
    const { options, challengeId } = await loginOptions(kernel.db, relyingParty(config.origin));
    setChallenge(c, challengeId);
    return c.json(options);
  });

  app.post("/login/verify", async (c) => {
    const { kernel, config } = c.get("deps");
    const body = verifyBody.safeParse(await c.req.json().catch(() => null));
    const challengeId = takeChallengeCookie(c);
    if (!body.success || !challengeId) return c.json({ error: "Start again." }, 400);
    const principal = await verifyLogin(
      kernel.db,
      relyingParty(config.origin),
      challengeId,
      body.data.response as never,
    ).catch(() => null);
    if (!principal) return c.json({ error: "That passkey didn't work." }, 401);
    await signIn(c, principal);
    return c.json({ ok: true });
  });

  app.post("/logout", async (c) => {
    const { kernel } = c.get("deps");
    const token = c.get("token");
    if (token && c.get("viaCookie")) await revokeToken(kernel.db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
