// Sign-in with passkeys. The first passkey is added with the setup code `hearth setup` prints;
// after that, new passkeys can only be added from a signed-in session.

import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE } from "../auth/middleware.ts";
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

function secure(c: Context<AppEnv>): boolean {
  return c.get("deps").config.origin.startsWith("https://");
}

function setChallenge(c: Context<AppEnv>, id: string) {
  setCookie(c, CHALLENGE_COOKIE, id, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secure(c),
    path: "/api/auth",
    maxAge: 300,
  });
}

function takeChallengeCookie(c: Context<AppEnv>): string | null {
  const id = getCookie(c, CHALLENGE_COOKIE) ?? null;
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/api/auth" });
  return id;
}

async function signIn(c: Context<AppEnv>, principal: string) {
  const { kernel } = c.get("deps");
  const token = await createSession(kernel.db, {
    principal,
    kind: "browser",
    label: c.req.header("user-agent")?.slice(0, 120) ?? "browser",
    ttlDays: SESSION_DAYS,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secure(c),
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

export function authRoutes() {
  const app = new Hono<AppEnv>();

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
