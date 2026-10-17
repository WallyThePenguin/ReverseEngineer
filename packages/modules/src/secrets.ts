// Google's tokens at rest (D58): sealed with the vault key like saved sign-ins and the Slack and
// GitHub tokens (D29), so a copy of the database or a backup of it can't be used to read your
// mail. The key lives outside the database, in vault.key or HEARTH_VAULT_KEY, and must be kept
// somewhere safe: without it, every sealed token needs connecting again.
import { ActionError } from "@hearth/kernel";
import type { Vault } from "./browser/vault.ts";

/** Seals and opens secrets: the vault. */
export type Sealer = Pick<Vault, "seal" | "open">;

export type GoogleTokenKind = "refresh" | "access";

const SITE = "accounts.google.com";
/** Each token is tied to its account and kind, so it can't be moved to another row or column. */
const label = (email: string, kind: GoogleTokenKind) => `${email} ${kind}`;

/** Whether a stored value is sealed. Google's own tokens never start this way. */
export const isSealed = (stored: string): boolean => stored.startsWith("v1.");

/** A token to save. Without a vault (some tests) it's saved as it is. */
export function sealGoogleToken(
  vault: Sealer | null,
  email: string,
  kind: GoogleTokenKind,
  token: string,
): string {
  return vault ? vault.seal(SITE, label(email, kind), token) : token;
}

/** A saved token, opened. One saved before tokens were sealed is read as it is. */
export function openGoogleToken(
  vault: Sealer | null,
  email: string,
  kind: GoogleTokenKind,
  stored: string,
): string {
  if (!isSealed(stored)) return stored;
  try {
    if (!vault) throw new Error("no vault");
    return vault.open(SITE, label(email, kind), stored);
  } catch {
    throw new ActionError(
      "failed",
      `Nook can't unlock its Google sign-in for ${email}. Connect it again in Settings.`,
    );
  }
}

/** A migration's connection: anything that runs SQL with values. */
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface TokenRow {
  email: string;
  refresh_token: string;
  access_token: string | null;
}

async function rewrite(
  client: SqlClient,
  change: (row: TokenRow, kind: GoogleTokenKind, value: string) => string,
): Promise<number> {
  const { rows } = await client.query(
    "SELECT email, refresh_token, access_token FROM google_account ORDER BY email FOR UPDATE",
  );
  let changed = 0;
  for (const row of rows as TokenRow[]) {
    const refresh = change(row, "refresh", row.refresh_token);
    const access = row.access_token === null ? null : change(row, "access", row.access_token);
    if (refresh === row.refresh_token && access === row.access_token) continue;
    await client.query(
      "UPDATE google_account SET refresh_token = $2, access_token = $3 WHERE email = $1",
      [row.email, refresh, access],
    );
    changed++;
  }
  return changed;
}

/** Seals every Google token still saved in the clear. Safe to run again. */
export function sealGoogleTokens(client: SqlClient, vault: Sealer): Promise<number> {
  return rewrite(client, (row, kind, value) =>
    isSealed(value) ? value : sealGoogleToken(vault, row.email, kind, value),
  );
}

/** Opens every sealed Google token, for going back to a Hearth that reads them in the clear. */
export function openGoogleTokens(client: SqlClient, vault: Sealer): Promise<number> {
  return rewrite(client, (row, kind, value) => openGoogleToken(vault, row.email, kind, value));
}

/**
 * The steps of Hearth's migrations that are code, not SQL: 0028 seals Google's tokens on the way
 * up and opens them on the way down. A token that can't be opened stops the way down, so an older
 * Hearth is never handed one it would send to Google sealed.
 */
export function secretMigrations(vault: Sealer) {
  return {
    "0028_trust": {
      up: async (client: SqlClient) => void (await sealGoogleTokens(client, vault)),
      down: async (client: SqlClient) => void (await openGoogleTokens(client, vault)),
    },
  };
}
