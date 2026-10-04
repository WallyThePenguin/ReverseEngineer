// Bearer tokens for browser sessions and API clients. Only a hash is stored; the token itself
// is shown once, when it's made.
import { timingSafeEqual } from "node:crypto";
import type { PrincipalKind } from "@hearth/core";
import { createSession, type DbOrTx, hashToken, newToken, principal, session } from "@hearth/db";
import { and, eq, isNull, like, lte, not, or } from "drizzle-orm";

export { createSession, hashToken, newToken };

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SessionPrincipal {
  principal: string;
  kind: PrincipalKind;
  sessionKind: "browser" | "api";
  /** A device's token may run only these actions; null for a full sign-in. */
  scopes: string[] | null;
}

/** How long a browser sign-in lasts without being used. Using it starts the time again. */
export const SESSION_DAYS = 30;
/** "Last seen" (and a sign-in's expiry) is written at most this often, not on every request. */
export const TOUCH_EVERY_MS = 5 * 60_000;

export type TokenRefusal = "unknown" | "revoked" | "expired" | "disabled";

export type TokenCheck =
  | {
      ok: true;
      session: SessionPrincipal;
      /** Set when this use moved a browser sign-in's expiry: the cookie should follow. */
      extendedUntil: Date | null;
    }
  | { ok: false; reason: TokenRefusal };

/**
 * Who a token belongs to, or why it's refused. Using a browser sign-in slides its expiry to
 * SESSION_DAYS from now, so one you use never runs out (D56). `touch: false` checks without
 * counting as a use.
 */
export async function checkToken(
  db: DbOrTx,
  token: string,
  now = new Date(),
  opts: { touch?: boolean } = {},
): Promise<TokenCheck> {
  if (!token || token.length > 200) return { ok: false, reason: "unknown" };
  const hash = hashToken(token);
  const [row] = await db
    .select({
      principal: session.principal,
      sessionKind: session.kind,
      kind: principal.kind,
      disabled: principal.disabledAt,
      scopes: session.scopes,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
    })
    .from(session)
    .innerJoin(principal, eq(principal.id, session.principal))
    .where(eq(session.tokenHash, hash));
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt && row.expiresAt <= now) return { ok: false, reason: "expired" };
  if (row.disabled) return { ok: false, reason: "disabled" };
  const result: TokenCheck = {
    ok: true,
    session: {
      principal: row.principal,
      kind: row.kind,
      sessionKind: row.sessionKind,
      scopes: row.scopes ?? null,
    },
    extendedUntil: null,
  };
  const stale = !row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS;
  if (opts.touch === false || !stale) return result;
  // Only browser sign-ins slide. API and device tokens never expire, and the short internal ones
  // the worker and Jarvis mint should run out on schedule.
  const slides = row.sessionKind === "browser" && row.expiresAt !== null;
  const until = slides ? new Date(now.getTime() + SESSION_DAYS * 86_400_000) : null;
  try {
    // Guarded the same way in the database, so requests arriving together write it once.
    const touched = await db
      .update(session)
      .set({ lastSeenAt: now, ...(until ? { expiresAt: until } : {}) })
      .where(
        and(
          eq(session.tokenHash, hash),
          or(
            isNull(session.lastSeenAt),
            lte(session.lastSeenAt, new Date(now.getTime() - TOUCH_EVERY_MS)),
          ),
        ),
      )
      .returning({ hash: session.tokenHash });
    if (touched.length > 0) result.extendedUntil = until;
  } catch (err) {
    // A database that can't take writes right now shouldn't sign anyone out.
    console.error(`[auth] couldn't record a session's use: ${(err as Error).message}`);
  }
  return result;
}

export async function resolveToken(
  db: DbOrTx,
  token: string,
  now = new Date(),
): Promise<SessionPrincipal | null> {
  const r = await checkToken(db, token, now);
  return r.ok ? r.session : null;
}

export async function revokeToken(db: DbOrTx, token: string, now = new Date()): Promise<void> {
  await db
    .update(session)
    .set({ revokedAt: now })
    .where(eq(session.tokenHash, hashToken(token)));
}

/** Makes a principal for an outside agent and an API token for it. The token is shown once. */
export async function createApiToken(
  db: DbOrTx,
  name: string,
  now = new Date(),
): Promise<{ principal: string; token: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    throw new Error("Token names are lowercase letters, digits and dashes, like claude-desktop.");
  }
  const id = `mcp:${name}`;
  await db
    .insert(principal)
    .values({ id, kind: "mcp_client", displayName: name, createdAt: now })
    .onConflictDoUpdate({ target: principal.id, set: { disabledAt: null } });
  const token = await createSession(
    db,
    { principal: id, kind: "api", label: name, ttlDays: null },
    now,
  );
  return { principal: id, token };
}

export async function listApiTokens(db: DbOrTx) {
  return db
    .select({
      principal: session.principal,
      label: session.label,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      revokedAt: session.revokedAt,
    })
    .from(session)
    .where(and(eq(session.kind, "api"), not(like(session.label, "device:%"))));
}

/** Revokes every token for an outside agent and disables it. */
export async function revokeApiTokens(db: DbOrTx, name: string, now = new Date()): Promise<number> {
  const id = name.startsWith("mcp:") ? name : `mcp:${name}`;
  const rows = await db
    .update(session)
    .set({ revokedAt: now })
    .where(and(eq(session.principal, id), eq(session.kind, "api"), isNull(session.revokedAt)))
    .returning({ hash: session.tokenHash });
  await db.update(principal).set({ disabledAt: now }).where(eq(principal.id, id));
  return rows.length;
}
