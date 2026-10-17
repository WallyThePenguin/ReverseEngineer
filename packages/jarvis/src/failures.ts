// Why a Jarvis turn failed, sorted into a few kinds, and what Hearth does about each (D54):
// passing trouble is tried again later, a rejected request isn't, and the owner reads a short,
// plain sentence, never the API's error text.
import { formatTime, localDate } from "@hearth/core";

export type FailureKind =
  /** The API rejected one tool's definition (a 400 naming tools.N). */
  | "bad_tool"
  /** Any other rejected request: sending it again fails the same way. */
  | "invalid_request"
  /** Claude refused the login (expired, signed out, billing). */
  | "auth"
  /** The owner's usage limit, or a 429. */
  | "rate_limit"
  /** Claude is overloaded or had a server error. */
  | "overloaded"
  /** Claude couldn't be reached. */
  | "network"
  /** The model process died. */
  | "crashed"
  /** The agent session to resume is gone. */
  | "session_gone"
  /** The turn ran past its lane's time limit. */
  | "timeout"
  /** The owner pressed Stop. */
  | "canceled"
  /** Jarvis restarted while the turn ran. */
  | "interrupted"
  | "unknown";

/** Kinds worth another try, as long as no tool had run yet (D54). */
export const PASSING: ReadonlySet<FailureKind> = new Set([
  "rate_limit",
  "overloaded",
  "network",
  "crashed",
]);

/** Minutes to wait before each retry of passing trouble: three retries at most. */
export const BACKOFF_MINUTES = [1, 5, 15];

/** What a brain throws when it knows why a turn failed. */
export class BrainError extends Error {
  readonly kind: FailureKind;
  /** When a usage limit lifts, if Claude said. */
  readonly resetsAt: Date | null;
  /** For bad_tool: the position of the rejected tool in the request. */
  readonly toolIndex: number | null;
  /** For bad_tool: that tool's name, as the brain's request named it. */
  readonly tool: string | null;

  constructor(
    kind: FailureKind,
    message: string,
    extra: { resetsAt?: Date | null; toolIndex?: number | null; tool?: string | null } = {},
  ) {
    super(message);
    this.name = "BrainError";
    this.kind = kind;
    this.resetsAt = extra.resetsAt ?? null;
    this.toolIndex = extra.toolIndex ?? null;
    this.tool = extra.tool ?? null;
  }
}

export interface Failure {
  kind: FailureKind;
  /** The raw error, for the log and the turn row. Never shown in a conversation. */
  message: string;
  resetsAt: Date | null;
  toolIndex: number | null;
  tool: string | null;
}

/** The error kinds the Agent SDK puts on an assistant message that stands for a failed call. */
const SDK_KINDS: Record<string, FailureKind> = {
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  account_on_hold: "auth",
  verification_required: "auth",
  billing_error: "auth",
  cloud_credential_error: "auth",
  rate_limit: "rate_limit",
  overloaded: "overloaded",
  server_error: "overloaded",
  invalid_request: "invalid_request",
  model_not_found: "invalid_request",
};

const BAD_TOOL = /\btools\.(\d+)\.[\w.]*(?:input_schema|schema)/i;

/** A failure Hearth itself decided on (stopped, out of time, restarted), not one a brain threw. */
export function failure(kind: FailureKind, message: string): Failure {
  return { kind, message, resetsAt: null, toolIndex: null, tool: null };
}

/** Reads a failure from what a brain threw, or from the error text and the SDK's own label. */
export function classifyFailure(err: unknown, sdkKind?: string | null): Failure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BrainError)
    return {
      kind: err.kind,
      message,
      resetsAt: err.resetsAt,
      toolIndex: err.toolIndex,
      tool: err.tool,
    };
  const kind = kindFromText(message, sdkKind ?? null);
  const at = kind === "bad_tool" ? BAD_TOOL.exec(message) : null;
  return {
    kind,
    message,
    resetsAt: kind === "rate_limit" ? resetFromText(message) : null,
    toolIndex: at ? Number(at[1]) : null,
    tool: null,
  };
}

function kindFromText(m: string, sdkKind: string | null): FailureKind {
  if (BAD_TOOL.test(m) && !/\b(429|5\d\d)\b/.test(m)) return "bad_tool";
  if (/no conversation found/i.test(m)) return "session_gone";
  if (sdkKind && SDK_KINDS[sdkKind]) return SDK_KINDS[sdkKind]!;
  if (/\b401\b|\b403\b|authentication|invalid api key|oauth token|not logged in|\/login/i.test(m))
    return "auth";
  if (/\b429\b|rate.?limit|usage limit|limit reached|quota/i.test(m)) return "rate_limit";
  if (/\b(500|502|503|504|529)\b|overloaded|server error|service unavailable|bad gateway/i.test(m))
    return "overloaded";
  if (/exited with code|process exited|terminated by signal|was killed|SIGKILL|SIGTERM/i.test(m))
    return "crashed";
  if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|connection (error|refused|reset)|timed out/i.test(
      m,
    )
  )
    return "network";
  if (/\b400\b|invalid.request/i.test(m)) return "invalid_request";
  return "unknown";
}

/** "...usage limit reached|1760000000" carries the reset time in seconds. */
function resetFromText(m: string): Date | null {
  const epoch = /\|(\d{10})\b/.exec(m);
  return epoch ? new Date(Number(epoch[1]) * 1000) : null;
}

export interface Friendly {
  /** What the owner reads in the conversation. */
  text: string;
  /** Whether a Retry button makes sense (it doesn't while Hearth is already retrying). */
  retry: boolean;
}

export interface FriendlyContext {
  timeZone: string;
  now: Date;
  /** When Hearth will try again, if it will. */
  retryAt?: Date | null;
  /** The tool Jarvis had to leave out, for bad_tool. */
  tool?: string | null;
  /** The lane's time limit, for timeout. */
  limitMinutes?: number;
}

/** A short sentence per kind of failure, in the voice of the rest of Hearth. */
export function friendlyError(kind: FailureKind, c: FriendlyContext): Friendly {
  const day = (d: Date) => localDate(d, c.timeZone);
  const tomorrow = day(new Date(c.now.getTime() + 24 * 3600_000));
  const when = (d: Date) => {
    const time = formatTime(d, c.timeZone);
    if (day(d) === day(c.now)) return `at ${time}`;
    return day(d) === tomorrow ? `tomorrow at ${time}` : `on ${day(d)} at ${time}`;
  };
  // "10:40 a.m." already ends the sentence.
  const at = c.retryAt ? when(c.retryAt) : "";
  const later = at ? ` Pip will try again ${at}${at.endsWith(".") ? "" : "."}` : "";
  switch (kind) {
    case "canceled":
      return { text: "Stopped.", retry: true };
    case "rate_limit":
      return c.retryAt
        ? { text: `You've hit your Claude usage limit.${later}`, retry: false }
        : { text: "You've hit your Claude usage limit. Try again once it resets.", retry: true };
    case "overloaded":
      return c.retryAt
        ? { text: `Claude is overloaded right now.${later}`, retry: false }
        : { text: "Claude is overloaded right now, even after a few tries.", retry: true };
    case "network":
      return c.retryAt
        ? { text: `Pip couldn't reach Claude.${later}`, retry: false }
        : { text: "Pip couldn't reach Claude, even after a few tries.", retry: true };
    case "crashed":
      return c.retryAt
        ? { text: `Pip's model process stopped unexpectedly.${later}`, retry: false }
        : { text: "Pip's model process kept stopping, so this didn't finish.", retry: true };
    case "auth":
      return {
        text: "Pip is signed out of Claude. Run claude on the PC to sign in again, then retry.",
        retry: true,
      };
    case "timeout":
      return {
        text: `This ran past Pip's ${c.limitMinutes ?? 10}-minute limit, so it stopped.`,
        retry: true,
      };
    case "interrupted":
      return { text: "Pip restarted while working on this, so it didn't finish.", retry: true };
    case "bad_tool":
      return {
        text: `Part of Pip's setup${c.tool ? ` (the ${c.tool} tool)` : ""} was rejected, so this couldn't run. It's flagged in your inbox.`,
        retry: true,
      };
    case "invalid_request":
      return {
        text: "Claude turned down Pip's request, so this couldn't run. It's flagged in your inbox.",
        retry: true,
      };
    default:
      return { text: "Something went wrong, so this didn't finish. It's logged.", retry: true };
  }
}
