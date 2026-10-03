// Session tokens: only a hash is stored, and the token itself is shown once. Shared by the server
// (logins, API tokens) and the other processes, which mint short internal tokens to reach it.
import { createHash, randomBytes } from "node:crypto";
import type { DbOrTx } from "./client.ts";
import { session } from "./schema/index.ts";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  db: DbOrTx,
  input: {
    principal: string;
    kind: "browser" | "api";
    label?: string;
    ttlDays?: number | null;
    scopes?: string[] | null;
  },
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
    scopes: input.scopes ?? null,
  });
  return token;
}
