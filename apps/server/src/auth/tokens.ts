// Bearer tokens for browser sessions and API clients. Only a hash is stored; the token itself
// is shown once, when it's made.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrincipalKind } from "@hearth/core";
import { type DbOrTx, principal, session } from "@hearth/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SessionPrincipal {
  principal: string;
  kind: PrincipalKind;
  sessionKind: "browser" | "api";
}

export async function createSession(
  db: DbOrTx,
  input: { principal: string; kind: "browser" | "api"; label?: string; ttlDays?: number | null },
  now = new Date(),
): Promise<string> {
  const token = newToken();
  await db.insert(session).values({
    tokenHash: hashToken(token),
    principal: input.principal,
    kind: input.kind,
    label: input.label ?? "",
    createdAt: now,
    expiresAt: input.ttlDays ? new Date(now.getTime() + input.ttlDays * 86_400_000) : null,
  });
  return token;
}

export async function resolveToken(
  db: DbOrTx,
  token: string,
  now = new Date(),
): Promise<SessionPrincipal | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({
      principal: session.principal,
      sessionKind: session.kind,
      kind: principal.kind,
      disabled: principal.disabledAt,
    })
    .from(session)
    .innerJoin(principal, eq(principal.id, session.principal))
    .where(
      and(
        eq(session.tokenHash, hashToken(token)),
        isNull(session.revokedAt),
        or(isNull(session.expiresAt), gt(session.expiresAt, now)),
      ),
    );
  if (!row || row.disabled) return null;
  await db
    .update(session)
    .set({ lastSeenAt: now })
    .where(eq(session.tokenHash, hashToken(token)));
  return { principal: row.principal, kind: row.kind, sessionKind: row.sessionKind };
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
    .where(eq(session.kind, "api"));
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
