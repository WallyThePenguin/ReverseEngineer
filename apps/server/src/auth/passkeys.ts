// Passkey (WebAuthn) login for the owner. The first passkey needs the one-time setup code from
// `hearth setup`; more can be added from a signed-in session.
import { randomBytes } from "node:crypto";
import { authChallenge, credential, type Db, setting } from "@hearth/db";
import { logLine } from "@hearth/kernel";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq, gt, lt } from "drizzle-orm";
import { hashToken, safeEqual } from "./tokens.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;

/** Why a passkey sign-in or registration failed, for the server log; the screen stays plain. */
function authFailed(what: "sign-in" | "registration", why: string) {
  console.warn(`[auth] passkey ${what} failed: ${why}`);
}

/** Runs a check that can throw (SimpleWebAuthn explains origin and RP ID mismatches that way). */
async function explained<T>(
  what: "sign-in" | "registration",
  fn: () => Promise<T>,
  failed: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    authFailed(what, (err as Error).message);
    return failed;
  }
}

/** Notes a failure on Hearth's side (the database, say) before passing it on. */
async function logged<T>(what: "sign-in" | "registration", fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // Without the query's values: they hold the challenge and the passkey's public key.
    authFailed(what, `Hearth couldn't check it: ${logLine(err)}`);
    throw err;
  }
}
export const SETUP_CODE_KEY = "auth.setupCodeHash";

export interface RelyingParty {
  origin: string;
  rpID: string;
}

export function relyingParty(origin: string): RelyingParty {
  return { origin, rpID: new URL(origin).hostname };
}

export async function hasPasskey(db: Db): Promise<boolean> {
  const rows = await db.select({ id: credential.id }).from(credential).limit(1);
  return rows.length > 0;
}

export async function checkSetupCode(db: Db, code: string): Promise<boolean> {
  const [row] = await db.select().from(setting).where(eq(setting.key, SETUP_CODE_KEY));
  const stored = row?.value as { hash: string; expiresAt: string } | undefined;
  if (!stored || new Date(stored.expiresAt) < new Date()) return false;
  return safeEqual(stored.hash, hashToken(code.trim().toUpperCase()));
}

export async function createSetupCode(db: Db, now = new Date()): Promise<string> {
  const code = randomBytes(5).toString("hex").toUpperCase();
  const value = {
    hash: hashToken(code),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  };
  await db
    .insert(setting)
    .values({ key: SETUP_CODE_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } });
  return code;
}

async function saveChallenge(
  db: Db,
  purpose: "register" | "login",
  challenge: string,
): Promise<string> {
  const id = randomBytes(18).toString("base64url");
  const now = new Date();
  // Abandoned sign-ins leave challenges behind; clear the expired ones as new ones are made.
  await db.delete(authChallenge).where(lt(authChallenge.expiresAt, now));
  await db.insert(authChallenge).values({
    id,
    challenge,
    purpose,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });
  return id;
}

async function takeChallenge(
  db: Db,
  id: string,
  purpose: "register" | "login",
): Promise<string | null> {
  const [row] = await db
    .delete(authChallenge)
    .where(
      and(
        eq(authChallenge.id, id),
        eq(authChallenge.purpose, purpose),
        gt(authChallenge.expiresAt, new Date()),
      ),
    )
    .returning();
  return row?.challenge ?? null;
}

export async function registrationOptions(db: Db, rp: RelyingParty) {
  const existing = await db.select().from(credential);
  const options = await generateRegistrationOptions({
    rpName: "Hearth",
    rpID: rp.rpID,
    userName: "owner",
    userDisplayName: "You",
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  return { options, challengeId: await saveChallenge(db, "register", options.challenge) };
}

export async function verifyRegistration(
  db: Db,
  rp: RelyingParty,
  challengeId: string,
  response: Parameters<typeof verifyRegistrationResponse>[0]["response"],
  label: string,
): Promise<boolean> {
  return logged("registration", () => checkRegistration(db, rp, challengeId, response, label));
}

async function checkRegistration(
  db: Db,
  rp: RelyingParty,
  challengeId: string,
  response: Parameters<typeof verifyRegistrationResponse>[0]["response"],
  label: string,
): Promise<boolean> {
  const challenge = await takeChallenge(db, challengeId, "register");
  if (!challenge) {
    authFailed("registration", "the challenge expired or was already used");
    return false;
  }
  const result = await explained(
    "registration",
    () =>
      verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
      }),
    null,
  );
  if (!result?.verified) {
    if (result) authFailed("registration", "the authenticator's response didn't verify");
    return false;
  }
  const c = result.registrationInfo.credential;
  await db.insert(credential).values({
    id: c.id,
    principal: "owner",
    publicKey: Buffer.from(c.publicKey),
    counter: c.counter,
    transports: c.transports ?? [],
    label: label.slice(0, 100),
  });
  await db.delete(setting).where(eq(setting.key, SETUP_CODE_KEY));
  return true;
}

export async function loginOptions(db: Db, rp: RelyingParty) {
  const creds = await db.select().from(credential);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    userVerification: "preferred",
  });
  return { options, challengeId: await saveChallenge(db, "login", options.challenge) };
}

export async function verifyLogin(
  db: Db,
  rp: RelyingParty,
  challengeId: string,
  response: Parameters<typeof verifyAuthenticationResponse>[0]["response"],
): Promise<string | null> {
  return logged("sign-in", () => checkLogin(db, rp, challengeId, response));
}

async function checkLogin(
  db: Db,
  rp: RelyingParty,
  challengeId: string,
  response: Parameters<typeof verifyAuthenticationResponse>[0]["response"],
): Promise<string | null> {
  const challenge = await takeChallenge(db, challengeId, "login");
  if (!challenge) {
    authFailed("sign-in", "the challenge expired or was already used");
    return null;
  }
  const [cred] = await db.select().from(credential).where(eq(credential.id, response.id));
  if (!cred) {
    authFailed("sign-in", "Hearth doesn't know that passkey (it may have been removed)");
    return null;
  }
  const result = await explained(
    "sign-in",
    () =>
      verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports,
        },
      }),
    null,
  );
  if (!result?.verified) {
    if (result) authFailed("sign-in", "the passkey's signature didn't verify");
    return null;
  }
  await db
    .update(credential)
    .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(credential.id, cred.id));
  return cred.principal;
}
