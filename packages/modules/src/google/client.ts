// Talking to Google: signing in with OAuth (PKCE, a Desktop-app client), keeping access tokens
// fresh, and making API calls as one of your connected accounts. No Google SDK; plain fetch, so
// tests can swap in a fake Google.
import { createHash, randomBytes } from "node:crypto";
import { type DbOrTx, googleAccount, oauthState } from "@hearth/db";
import { ActionError } from "@hearth/kernel";
import { eq, lt } from "drizzle-orm";

/** The kernel service name actions use: ctx.service<GoogleClient>(GOOGLE_SERVICE). */
export const GOOGLE_SERVICE = "google";

export const SCOPES = {
  identity: ["openid", "email"],
  calendar: ["https://www.googleapis.com/auth/calendar"],
  gmail: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ],
} as const;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleConfig {
  clientId: string | null;
  clientSecret: string | null;
  /** Where Google sends you back after signing in: a loopback address on this PC. */
  redirectUri: string;
  fetch?: Fetch;
}

export class GoogleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GoogleApiError";
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export class GoogleClient {
  readonly config: GoogleConfig;
  private readonly fetch: Fetch;
  /** Token lookups, one at a time: calls made in parallel share one database connection. */
  private tokens: Promise<unknown> = Promise.resolve();

  constructor(config: GoogleConfig) {
    this.config = config;
    this.fetch = config.fetch ?? ((url, init) => fetch(url, init));
  }

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private requireConfig(): { clientId: string; clientSecret: string } {
    const { clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret)
      throw new ActionError(
        "unavailable",
        "Google isn't set up yet: HEARTH_GOOGLE_CLIENT_ID and HEARTH_GOOGLE_CLIENT_SECRET are missing from .env.",
      );
    return { clientId, clientSecret };
  }

  /** Starts a sign-in: saves the state and verifier, and returns Google's consent address. */
  async startSignIn(db: DbOrTx, scopes: string[], now = new Date()): Promise<string> {
    const { clientId } = this.requireConfig();
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const all = [...new Set([...SCOPES.identity, ...scopes])];
    await db.delete(oauthState).where(lt(oauthState.expiresAt, now));
    await db.insert(oauthState).values({
      state,
      verifier,
      scopes: all,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: all.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      // Always ask, so Google always returns a refresh token and adds new scopes.
      prompt: "consent",
      include_granted_scopes: "true",
    }).toString();
    return url.toString();
  }

  /** Finishes a sign-in: trades the code for tokens and saves the account. Returns its email. */
  async finishSignIn(db: DbOrTx, state: string, code: string, now = new Date()): Promise<string> {
    const { clientId, clientSecret } = this.requireConfig();
    const [pending] = await db.select().from(oauthState).where(eq(oauthState.state, state));
    await db.delete(oauthState).where(eq(oauthState.state, state));
    if (!pending || pending.expiresAt < now)
      throw new ActionError("forbidden", "That sign-in link expired. Start again from Settings.");
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: pending.verifier,
        grant_type: "authorization_code",
        redirect_uri: this.config.redirectUri,
      }),
    });
    const tokens = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error_description?: string;
    };
    if (!res.ok || !tokens.access_token)
      throw new ActionError(
        "failed",
        `Google refused the sign-in: ${tokens.error_description ?? res.status}`,
      );
    const who = await this.fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const info = (await who.json()) as { email?: string };
    if (!info.email) throw new ActionError("failed", "Google didn't say which account this is.");
    const email = info.email.toLowerCase();
    const scopes = (tokens.scope ?? pending.scopes.join(" ")).split(" ").filter(Boolean);
    const [existing] = await db.select().from(googleAccount).where(eq(googleAccount.email, email));
    const refreshToken = tokens.refresh_token ?? existing?.refreshToken;
    if (!refreshToken)
      throw new ActionError(
        "failed",
        "Google didn't return a refresh token. Try connecting again.",
      );
    const values = {
      refreshToken,
      scopes: [...new Set([...(existing?.scopes ?? []), ...scopes])],
      accessToken: tokens.access_token,
      accessExpiresAt: new Date(now.getTime() + (tokens.expires_in ?? 3600) * 1000),
      status: "ok" as const,
      lastError: null,
    };
    await db
      .insert(googleAccount)
      .values({ email, connectedAt: now, ...values })
      .onConflictDoUpdate({ target: googleAccount.email, set: values });
    return email;
  }

  /** A fresh access token for an account, refreshing it when it's about to run out. */
  async accessToken(db: DbOrTx, email: string, now = new Date()): Promise<string> {
    const [acct] = await db.select().from(googleAccount).where(eq(googleAccount.email, email));
    if (!acct) throw new ActionError("not_found", `No Google account ${email} is connected.`);
    if (
      acct.accessToken &&
      acct.accessExpiresAt &&
      acct.accessExpiresAt.getTime() - now.getTime() > 60_000
    )
      return acct.accessToken;
    const { clientId, clientSecret } = this.requireConfig();
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: acct.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      const revoked = body.error === "invalid_grant";
      const message = revoked
        ? `Google signed Hearth out of ${email}. Connect it again in Settings.`
        : `Couldn't refresh Google access for ${email}: ${body.error_description ?? res.status}`;
      await db
        .update(googleAccount)
        .set({ status: revoked ? "revoked" : "failing", lastError: message })
        .where(eq(googleAccount.email, email));
      throw new ActionError("unavailable", message);
    }
    await db
      .update(googleAccount)
      .set({
        accessToken: body.access_token,
        accessExpiresAt: new Date(now.getTime() + (body.expires_in ?? 3600) * 1000),
        status: "ok",
        lastError: null,
      })
      .where(eq(googleAccount.email, email));
    return body.access_token;
  }

  /** Calls a Google API as an account. Returns parsed JSON, or null for an empty reply. */
  async call<T>(
    db: DbOrTx,
    email: string,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<T> {
    const next = this.tokens.then(() => this.accessToken(db, email));
    this.tokens = next.catch(() => {});
    const token = await next;
    const res = await this.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {}
      throw new GoogleApiError(res.status, `Google ${method} ${new URL(url).pathname}: ${message}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** The Google client from .env. Unconfigured (but present) when the client id is missing. */
export function googleFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleClient {
  const port = env.HEARTH_PORT ?? "4400";
  return new GoogleClient({
    clientId: env.HEARTH_GOOGLE_CLIENT_ID || null,
    clientSecret: env.HEARTH_GOOGLE_CLIENT_SECRET || null,
    redirectUri: env.HEARTH_GOOGLE_REDIRECT ?? `http://localhost:${port}/api/google/callback`,
  });
}
