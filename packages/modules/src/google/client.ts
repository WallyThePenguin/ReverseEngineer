// Talking to Google: signing in with OAuth (PKCE, a Desktop-app client), keeping access tokens
// fresh, and making API calls as one of your connected accounts. No Google SDK; plain fetch, so
// tests can swap in a fake Google. Every call is paced against a budget shared by all of Hearth's
// processes, and gives up after 30 seconds (D55).
import { createHash, randomBytes } from "node:crypto";
import { type Db, type DbOrTx, googleAccount, oauthState } from "@hearth/db";
import { ActionError } from "@hearth/kernel";
import { eq, lt } from "drizzle-orm";
import { vaultFromEnv } from "../browser/vault.ts";
import { openGoogleToken, type Sealer, sealGoogleToken } from "../secrets.ts";
import {
  type Allowance,
  DbQuotaStore,
  GoogleBudget,
  type GoogleService,
  MemoryQuotaStore,
  MIN_PAUSE_MS,
} from "./budget.ts";
import { GoogleApiError, networkError, parseGoogleError } from "./errors.ts";
import { GoogleTokens } from "./tokens.ts";

export { GoogleApiError } from "./errors.ts";

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
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
/** A request with no answer by then is abandoned, so a hung connection can't hold a sync. */
export const REQUEST_TIMEOUT_MS = 30_000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleConfig {
  clientId: string | null;
  clientSecret: string | null;
  /** Where Google sends you back after signing in: a loopback address on this PC. */
  redirectUri: string;
  fetch?: Fetch;
  /**
   * Hearth's database, for what all processes share: access tokens, the call budget and pauses.
   * Written in short transactions of the client's own, never inside an action's. Without it
   * (some tests), the budget is kept in this process and tokens in the caller's transaction.
   */
  db?: Db | null;
  now?: () => Date;
  timeoutMs?: number;
  /** Per-minute allowances by service, instead of the defaults in budget.ts. */
  allowances?: Partial<Record<GoogleService, Allowance>>;
  log?: (msg: string) => void;
  /** Seals the tokens it saves (D58). Without it (some tests) they're saved as they are. */
  vault?: Sealer | null;
}

export interface CallOptions {
  /** Quota units the call costs (budget.ts). Defaults to 1. */
  cost?: number;
  /** The owner is waiting on it (sending mail): it may use the budget's headroom. */
  priority?: boolean;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Gmail and Calendar have separate quotas at Google. */
function serviceOf(url: string): GoogleService {
  return new URL(url).hostname.startsWith("gmail.") ? "gmail" : "calendar";
}

export class GoogleClient {
  readonly config: GoogleConfig;
  private readonly fetch: Fetch;
  private readonly db: Db | null;
  private readonly budget: GoogleBudget;
  private readonly log: (msg: string) => void;
  private readonly tokens: GoogleTokens;

  constructor(config: GoogleConfig) {
    this.config = config;
    this.fetch = config.fetch ?? ((url, init) => fetch(url, init));
    this.db = config.db ?? null;
    this.budget = new GoogleBudget(
      this.db ? new DbQuotaStore(this.db) : new MemoryQuotaStore(),
      config.allowances,
    );
    this.log = config.log ?? ((msg) => console.warn(`[google] ${msg}`));
    this.tokens = new GoogleTokens({
      db: this.db,
      request: (url, init, what) => this.request(url, init, what),
      now: () => this.now().getTime(),
      credentials: () => this.requireConfig(),
      vault: config.vault ?? null,
    });
  }

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
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

  /** fetch, abandoned after the timeout. A network error or timeout is a "transient" error. */
  private async request(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await this.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err, what);
    }
  }

  /** Starts a sign-in: saves the state and verifier, and returns Google's consent address. */
  async startSignIn(db: DbOrTx, scopes: string[], now = this.now()): Promise<string> {
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
  async finishSignIn(db: DbOrTx, state: string, code: string, now = this.now()): Promise<string> {
    const { clientId, clientSecret } = this.requireConfig();
    const [pending] = await db.select().from(oauthState).where(eq(oauthState.state, state));
    await db.delete(oauthState).where(eq(oauthState.state, state));
    if (!pending || pending.expiresAt < now)
      throw new ActionError("forbidden", "That sign-in link expired. Start again from Settings.");
    const res = await this.request(
      TOKEN_URL,
      {
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
      },
      "sign-in",
    );
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
    const who = await this.request(
      USERINFO_URL,
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
      "sign-in",
    );
    const info = (await who.json()) as { email?: string };
    if (!info.email) throw new ActionError("failed", "Google didn't say which account this is.");
    const email = info.email.toLowerCase();
    const scopes = (tokens.scope ?? pending.scopes.join(" ")).split(" ").filter(Boolean);
    const [existing] = await db.select().from(googleAccount).where(eq(googleAccount.email, email));
    const vault = this.config.vault ?? null;
    const refreshToken =
      tokens.refresh_token ??
      (existing ? openGoogleToken(vault, email, "refresh", existing.refreshToken) : undefined);
    if (!refreshToken)
      throw new ActionError(
        "failed",
        "Google didn't return a refresh token. Try connecting again.",
      );
    const expiresAt = now.getTime() + (tokens.expires_in ?? 3600) * 1000;
    const values = {
      refreshToken: sealGoogleToken(vault, email, "refresh", refreshToken),
      scopes: [...new Set([...(existing?.scopes ?? []), ...scopes])],
      accessToken: sealGoogleToken(vault, email, "access", tokens.access_token),
      accessExpiresAt: new Date(expiresAt),
      status: "ok" as const,
      lastError: null,
    };
    await db
      .insert(googleAccount)
      .values({ email, connectedAt: now, ...values })
      .onConflictDoUpdate({ target: googleAccount.email, set: values });
    this.tokens.remember(email, tokens.access_token, expiresAt);
    return email;
  }

  /**
   * Tells Google to drop Hearth's access, so a forgotten token is useless. Best effort. Takes the
   * token as saved; with the account's email, a sealed one is opened first.
   */
  async revoke(saved: string, email?: string): Promise<void> {
    let refreshToken = saved;
    try {
      if (email) refreshToken = openGoogleToken(this.config.vault ?? null, email, "refresh", saved);
    } catch {
      return;
    }
    await this.request(
      REVOKE_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }),
      },
      "revoke",
    ).catch(() => {});
  }

  /**
   * A fresh access token for an account: one refresh at a time per account, saved outside the
   * caller's transaction (6.1). `refused` is a token Google just turned down.
   */
  accessToken(db: DbOrTx, email: string, refused?: string): Promise<string> {
    return this.tokens.get(db, email, refused);
  }

  /**
   * Calls a Google API as an account. Returns parsed JSON, or null for an empty reply. Throws a
   * GoogleApiError; a "rate_limited" one has already paused the account's service for everyone.
   * Never waits: a call the budget can't take this minute fails at once as "paced".
   */
  async call<T>(
    db: DbOrTx,
    email: string,
    method: string,
    url: string,
    body?: unknown,
    opts: CallOptions = {},
  ): Promise<T> {
    const service = serviceOf(url);
    const what = `${method} ${new URL(url).pathname}`;
    await this.budget.spend(
      email,
      service,
      opts.cost ?? 1,
      opts.priority ?? false,
      this.now().getTime(),
    );
    const send = (token: string) =>
      this.request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        what,
      );
    let token = await this.accessToken(db, email);
    let res = await send(token);
    if (res.status === 401) {
      // Turned down: refresh and try once more. Turned down again means reconnect.
      this.tokens.forget(email);
      token = await this.accessToken(db, email, token);
      res = await send(token);
    }
    const text = await res.text().catch((err: unknown) => {
      throw networkError(err, what);
    });
    if (res.ok) return (text ? JSON.parse(text) : null) as T;
    const err = parseGoogleError(res, text, what, this.now().getTime());
    if (err.kind === "rate_limited") throw await this.slowDown(email, service, err);
    if (err.kind === "auth") await this.needsReconnect(db, email);
    throw err;
  }

  /** Google said slow down: pause this account's service for every process, a minute at least. */
  private async slowDown(email: string, service: GoogleService, err: GoogleApiError) {
    const pauseMs = Math.max(MIN_PAUSE_MS, err.retryAfterMs ?? 0);
    const until = this.now().getTime() + pauseMs;
    await this.budget.pause(email, service, until);
    this.log(
      `${service} for ${email} paused until ${new Date(until).toISOString()}: ${err.message} (quota limit: ${err.quotaLimit ?? "not given"})`,
    );
    return new GoogleApiError(err.status, err.message, {
      kind: "rate_limited",
      reason: err.reason,
      retryAfterMs: pauseMs,
      quotaLimit: err.quotaLimit,
    });
  }

  private async needsReconnect(db: DbOrTx, email: string) {
    this.tokens.forget(email);
    await (this.db ?? db)
      .update(googleAccount)
      .set({
        status: "failing",
        lastError: `Google stopped accepting Hearth's access to ${email}. Connect it again in Settings.`,
      })
      .where(eq(googleAccount.email, email));
  }
}

/** The Google client from .env, with Hearth's database. Unconfigured when the client id is missing. */
export function googleFromEnv(db?: Db | null, env: NodeJS.ProcessEnv = process.env): GoogleClient {
  const port = env.HEARTH_PORT ?? "4400";
  return new GoogleClient({
    clientId: env.HEARTH_GOOGLE_CLIENT_ID || null,
    clientSecret: env.HEARTH_GOOGLE_CLIENT_SECRET || null,
    redirectUri: env.HEARTH_GOOGLE_REDIRECT ?? `http://localhost:${port}/api/google/callback`,
    db: db ?? null,
    vault: vaultFromEnv(env),
  });
}
