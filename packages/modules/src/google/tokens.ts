// Access tokens for connected Google accounts. Held in memory, refreshed one at a time per account
// (everyone who needs one meanwhile waits for the same refresh), and saved in a short write of
// their own, never inside an action's transaction: a sync that holds the account's row can't end
// up waiting on itself for a token (6.1).
import { type Db, type DbOrTx, googleAccount } from "@hearth/db";
import { ActionError } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { openGoogleToken, type Sealer, sealGoogleToken } from "../secrets.ts";
import { GoogleApiError } from "./errors.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Tokens this close to running out are refreshed first. */
const EXPIRY_MARGIN_MS = 60_000;

export interface TokenDeps {
  /** Hearth's database; without it (some tests) tokens are saved in the caller's transaction. */
  db: Db | null;
  request(url: string, init: RequestInit, what: string): Promise<Response>;
  now(): number;
  credentials(): { clientId: string; clientSecret: string };
  /** Seals tokens at rest (D58); without it (some tests) they're saved as they are. */
  vault: Sealer | null;
}

export class GoogleTokens {
  private readonly held = new Map<string, { token: string; expiresAt: number }>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly deps: TokenDeps;

  constructor(deps: TokenDeps) {
    this.deps = deps;
  }

  remember(email: string, token: string, expiresAt: number) {
    this.held.set(email, { token, expiresAt });
  }

  forget(email: string) {
    this.held.delete(email);
  }

  /** A fresh token. `refused` is one Google just turned down, so it isn't handed out again. */
  async get(db: DbOrTx, email: string, refused?: string): Promise<string> {
    const held = this.held.get(email);
    if (held && held.token !== refused && held.expiresAt - this.deps.now() > EXPIRY_MARGIN_MS)
      return held.token;
    const under = this.refreshing.get(email);
    if (under) {
      const token = await under;
      if (token !== refused) return token;
    }
    const flight: Promise<string> = this.refresh(db, email, refused).finally(() => {
      // Only this flight's own entry: a newer one may have taken its place meanwhile.
      if (this.refreshing.get(email) === flight) this.refreshing.delete(email);
    });
    this.refreshing.set(email, flight);
    return flight;
  }

  private async refresh(db: DbOrTx, email: string, refused?: string): Promise<string> {
    const store = this.deps.db ?? db;
    const [acct] = await store.select().from(googleAccount).where(eq(googleAccount.email, email));
    if (!acct) throw new ActionError("not_found", `No Google account ${email} is connected.`);
    const now = this.deps.now();
    // Another process may have refreshed it already.
    const saved = acct.accessExpiresAt?.getTime() ?? 0;
    // One that can't be opened is simply refreshed.
    let access: string | null = null;
    try {
      if (acct.accessToken)
        access = openGoogleToken(this.deps.vault, email, "access", acct.accessToken);
    } catch {}
    if (access && access !== refused && saved - now > EXPIRY_MARGIN_MS) {
      this.remember(email, access, saved);
      return access;
    }
    let refreshToken: string;
    try {
      refreshToken = openGoogleToken(this.deps.vault, email, "refresh", acct.refreshToken);
    } catch (err) {
      // Sealed with a vault key this Hearth doesn't have: Settings says to connect it again.
      const lastError = err instanceof Error ? err.message : String(err);
      await store
        .update(googleAccount)
        .set({ status: "failing", lastError })
        .where(eq(googleAccount.email, email));
      throw err;
    }
    const { clientId, clientSecret } = this.deps.credentials();
    const res = await this.deps.request(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      },
      "token refresh",
    );
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      // Google busy, or asking Hearth to slow down: try again later, nothing to reconnect.
      if (res.status >= 500 || res.status === 429 || res.status === 408)
        throw new GoogleApiError(
          res.status,
          `Google couldn't refresh access for ${email} just now.`,
          { kind: "transient" },
        );
      const revoked = body.error === "invalid_grant";
      const message = revoked
        ? `Google signed Hearth out of ${email}. Connect it again in Settings.`
        : `Couldn't refresh Google access for ${email}: ${body.error_description ?? res.status}`;
      await store
        .update(googleAccount)
        .set({ status: revoked ? "revoked" : "failing", lastError: message })
        .where(eq(googleAccount.email, email));
      throw new GoogleApiError(res.status, message, { kind: "auth", reason: body.error ?? null });
    }
    const expiresAt = now + (body.expires_in ?? 3600) * 1000;
    // If the vault key can't be had, the new token is kept in this process only (it lasts an
    // hour), never saved in the clear, and mail keeps working.
    let sealed: string | null = null;
    try {
      sealed = sealGoogleToken(this.deps.vault, email, "access", body.access_token);
    } catch {}
    await store
      .update(googleAccount)
      .set({
        accessToken: sealed,
        accessExpiresAt: new Date(expiresAt),
        status: "ok",
        lastError: null,
      })
      .where(eq(googleAccount.email, email));
    this.remember(email, body.access_token, expiresAt);
    return body.access_token;
  }
}
