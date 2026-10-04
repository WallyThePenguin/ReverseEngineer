// What a failed Google call means for Hearth: slow down, reconnect, try again soon, or give up.

/**
 * - rate_limited: Google said slow down (a quota 429 or 403), or a pause it asked for still holds.
 * - paced: Hearth held the call back itself, because this minute's budget is spent.
 * - auth: Google no longer accepts Hearth's access; the account needs connecting again.
 * - transient: a network error, a timeout or a 5xx. Trying again later may work.
 * - not_found: the thing asked for isn't there (or Gmail's history bookmark expired).
 * - refused: any other 4xx. Trying the same call again won't help.
 */
export type GoogleErrorKind =
  | "rate_limited"
  | "paced"
  | "auth"
  | "transient"
  | "not_found"
  | "refused";

export class GoogleApiError extends Error {
  /** The HTTP status; 0 when the call never got an answer (network, timeout, Hearth's pacing). */
  readonly status: number;
  readonly kind: GoogleErrorKind;
  /** Google's reason ("rateLimitExceeded", "RATE_LIMIT_EXCEEDED"...), or Hearth's own. */
  readonly reason: string | null;
  /** How long to wait before calling again, when that's known. */
  readonly retryAfterMs: number | null;
  /** Google's ErrorInfo quota_limit_value: the limit that was hit, when Google says. */
  readonly quotaLimit: string | null;

  constructor(
    status: number,
    message: string,
    details: {
      kind?: GoogleErrorKind;
      reason?: string | null;
      retryAfterMs?: number | null;
      quotaLimit?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.kind = details.kind ?? kindOf(status, details.reason ?? null, message);
    this.reason = details.reason ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.quotaLimit = details.quotaLimit ?? null;
  }

  /** Google asked Hearth to slow down, or Hearth is holding back: not a failure. */
  get slowDown(): boolean {
    return this.kind === "rate_limited" || this.kind === "paced";
  }
}

const RATE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);
const AUTH_REASONS = new Set([
  "authError",
  "insufficientPermissions",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "ACCESS_TOKEN_EXPIRED",
  "UNAUTHENTICATED",
]);

function kindOf(status: number, reason: string | null, message: string): GoogleErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 403 && ((reason && RATE_REASONS.has(reason)) || /rate ?limit|quota/i.test(message)))
    return "rate_limited";
  if (status === 401 || (status === 403 && reason && AUTH_REASONS.has(reason))) return "auth";
  if (status === 0 || status === 408 || status >= 500) return "transient";
  if (status === 404 || status === 410) return "not_found";
  return "refused";
}

interface GoogleErrorBody {
  error?: {
    message?: string;
    status?: string;
    errors?: { reason?: string }[];
    details?: { "@type"?: string; reason?: string; metadata?: Record<string, string> }[];
  };
}

/** Seconds or an HTTP date, as Retry-After allows. */
export function retryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Reads Google's error reply: its message, reason, quota details and Retry-After. */
export function parseGoogleError(
  res: { status: number; headers: Headers },
  text: string,
  what: string,
  now: number,
): GoogleApiError {
  let body: GoogleErrorBody = {};
  try {
    body = JSON.parse(text) as GoogleErrorBody;
  } catch {}
  const info = body.error?.details?.find((d) => d["@type"]?.endsWith("google.rpc.ErrorInfo"));
  const reason = body.error?.errors?.[0]?.reason ?? info?.reason ?? body.error?.status ?? null;
  const message = body.error?.message ?? text.slice(0, 300);
  return new GoogleApiError(res.status, `Google ${what}: ${message}`, {
    reason,
    retryAfterMs: retryAfter(res.headers.get("retry-after"), now),
    quotaLimit: info?.metadata?.quota_limit_value ?? null,
  });
}

/** A fetch that threw: a timeout or the network. Always worth trying again later. */
export function networkError(err: unknown, what: string): GoogleApiError {
  const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  const detail = err instanceof Error ? err.message : String(err);
  return new GoogleApiError(
    0,
    timeout ? `Google ${what}: no answer in time` : `Google ${what}: ${detail}`,
    { kind: "transient", reason: timeout ? "timeout" : "network" },
  );
}
