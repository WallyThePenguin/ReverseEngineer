// Passkey (WebAuthn) login for the owner. The first passkey needs the one-time setup code from
// `hearth setup`; more can be added from a signed-in session. A passkey works only at the address
// it was made at: Hearth's own, or the desktop app's window on this PC (D69, relying-party.ts).
// Each is kept to its own: offered, excluded and checked only there.
import { randomBytes } from "node:crypto";
import { authChallenge, credential, type Db, setting } from "@hearth/db";
import { logLine } from "@hearth/kernel";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
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
  /** The desktop app's window on this PC (D69): its passkeys are Windows Hello, kept apart. */
  local?: true;
}

export function relyingParty(origin: string): RelyingParty {
  return { origin, rpID: new URL(origin).hostname };
}

/** Rows made at this address: the window's say so, Hearth's own say nothing (rp_id is null). */
function madeAt(column: typeof credential.rpId | typeof authChallenge.rpId, rp: RelyingParty) {
  return rp.local ? eq(column, "localhost") : isNull(column);
}

export async function hasPasskey(db: Db): Promise<boolean> {
  const rows = await db.select({ id: credential.id }).from(credential).limit(1);
  return rows.length > 0;
}

/** Whether any passkey exists yet, and whether the window on this PC has its own. */
export async function passkeysMade(db: Db): Promise<{ any: boolean; window: boolean }> {
  const rows = await db.selectDistinct({ rpId: credential.rpId }).from(credential);
  return { any: rows.length > 0, window: rows.some((r) => r.rpId === "localhost") };
}

/** Your passkeys, with the address each one works at, for Settings. */
export async function listPasskeys(db: Db) {
  const rows = await db
    .select({
      label: credential.label,
      rpId: credential.rpId,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
    })
    .from(credential)
    .orderBy(credential.createdAt);
  return rows.map(({ rpId, ...r }) => ({ ...r, window: rpId === "localhost" }));
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
  rp: RelyingParty,
): Promise<string> {
  const id = randomBytes(18).toString("base64url");
  const now = new Date();
  // Abandoned sign-ins leave challenges behind; clear the expired ones as new ones are made.
  await db.delete(authChallenge).where(lt(authChallenge.expiresAt, now));
  await db.insert(authChallenge).values({
    id,
    challenge,
    purpose,
    rpId: rp.local ? "localhost" : null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });
  return id;
}

async function takeChallenge(
  db: Db,
  id: string,
  purpose: "register" | "login",
  rp: RelyingParty,
): Promise<string | null> {
  const [row] = await db
    .delete(authChallenge)
    .where(
      and(
        eq(authChallenge.id, id),
        eq(authChallenge.purpose, purpose),
        madeAt(authChallenge.rpId, rp),
        gt(authChallenge.expiresAt, new Date()),
      ),
    )
    .returning();
  return row?.challenge ?? null;
}

export async function registrationOptions(db: Db, rp: RelyingParty) {
  const existing = await db.select().from(credential).where(madeAt(credential.rpId, rp));
  const options = await generateRegistrationOptions({
    rpName: "Hearth",
    rpID: rp.rpID,
    userName: "owner",
    userDisplayName: "You",
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    // The window's is this PC's own Windows Hello: your face, finger or PIN every time.
    authenticatorSelection: rp.local
      ? {
          authenticatorAttachment: "platform",
          residentKey: "preferred",
          userVerification: "required",
        }
      : { residentKey: "preferred", userVerification: "preferred" },
  });
  return { options, challengeId: await saveChallenge(db, "register", options.challenge, rp) };
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
  const challenge = await takeChallenge(db, challengeId, "register", rp);
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
        requireUserVerification: true,
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
    rpId: rp.local ? "localhost" : null,
  });
  await db.delete(setting).where(eq(setting.key, SETUP_CODE_KEY));
  return true;
}

/** Null when no passkey works at this address yet. */
export async function loginOptions(db: Db, rp: RelyingParty) {
  const creds = await db.select().from(credential).where(madeAt(credential.rpId, rp));
  if (!creds.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    userVerification: rp.local ? "required" : "preferred",
  });
  return { options, challengeId: await saveChallenge(db, "login", options.challenge, rp) };
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
  const challenge = await takeChallenge(db, challengeId, "login", rp);
  if (!challenge) {
    authFailed("sign-in", "the challenge expired or was already used");
    return null;
  }
  const [cred] = await db
    .select()
    .from(credential)
    .where(and(eq(credential.id, response.id), madeAt(credential.rpId, rp)));
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
        requireUserVerification: true,
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
