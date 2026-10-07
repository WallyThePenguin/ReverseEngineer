// Talks to Hearth's server. Everything goes through POST /api/actions/:name, the same actions
// Jarvis and MCP clients use.

export type ActionResult<T> =
  | { status: "ok"; result: T }
  | { status: "pending_approval"; approvalId: string; summary: string; reason: string }
  | { status: "denied"; reason: string }
  | { status: "error"; code: string; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Errors that say nothing about the save itself: try again later. */
export const isTransient = (err: unknown) =>
  !(err instanceof ApiError) || ["unreachable", "unavailable", "failed"].includes(err.code);

/**
 * Hearth (or its database) out of reach, as opposed to Hearth failing at the save: only then do
 * messages say it can't be reached. A failure's own text is Hearth's internals, so it isn't shown.
 */
export const isOffline = (err: unknown) =>
  err instanceof ApiError && (err.code === "unreachable" || err.code === "unavailable");

/** Why a save that will be tried again hasn't happened yet, in plain words. */
export function notYet(err: unknown): string {
  if (isOffline(err)) return "Not saved yet: can't reach Hearth. Trying again…";
  if (err instanceof ApiError && err.code === "conflict")
    return "Not saved yet: it keeps changing elsewhere. Trying again…";
  return "Not saved yet: Hearth hit a problem saving it. Trying again…";
}

/** Set by the app so a 401 anywhere sends you back to the sign-in screen. */
let onSignedOut: () => void = () => {};
export function setSignedOutHandler(fn: () => void) {
  onSignedOut = fn;
}
/** Sends you back to the sign-in screen (the session ended). */
export function signedOut() {
  onSignedOut();
}

const UNREACHABLE = "Can't reach Hearth right now. Try again in a moment.";

export interface SendOptions {
  /** Gives up after this long, as if Hearth were out of reach. */
  timeoutMs?: number;
  /** Still sent if the page closes meanwhile (bodies up to 64 kB). */
  keepalive?: boolean;
}

async function post(path: string, body: unknown, opts: SendOptions = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
      ...(opts.keepalive ? { keepalive: true } : {}),
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
  } catch {
    // Offline, or the PC is out of reach.
    throw new ApiError(0, "unreachable", UNREACHABLE);
  }
  if (res.status === 401) onSignedOut();
  return res;
}

/**
 * An action's result from its reply. A reply that isn't one (Hearth's own short error, say for
 * its database being out of reach, or a proxy's error page) is thrown as an ApiError.
 */
async function resultOf<T>(res: Response): Promise<ActionResult<T>> {
  const body = (await res.json().catch(() => null)) as ActionResult<T> | { error: string } | null;
  if (!body || !("status" in body)) {
    const error = (body as { error?: string } | null)?.error;
    // A proxy's error page while Hearth restarts says nothing useful.
    if (!error && res.status >= 502) throw new ApiError(res.status, "unreachable", UNREACHABLE);
    throw new ApiError(res.status, "failed", error || res.statusText || "That didn't work.");
  }
  return body;
}

/** Runs an action and returns its full result, including approvals and denials. */
export async function runAction<T>(
  name: string,
  input: unknown = {},
  opts?: SendOptions,
): Promise<ActionResult<T>> {
  return resultOf<T>(await post(`/api/actions/${name}`, input, opts));
}

/** Runs an action and returns its result, or throws. */
export async function action<T>(name: string, input: unknown = {}, opts?: SendOptions): Promise<T> {
  const r = await runAction<T>(name, input, opts);
  if (r.status === "ok") return r.result;
  if (r.status === "pending_approval") throw new ApiError(202, "pending_approval", r.summary);
  if (r.status === "denied") throw new ApiError(403, "denied", r.reason);
  throw new ApiError(400, r.code, r.message);
}

/** Approves or denies. Throws, like runAction, when Hearth can't give an answer. */
export async function decideApproval(id: string, decision: "approve" | "deny") {
  return resultOf<unknown>(await post(`/api/approvals/${id}`, { decision }));
}

/**
 * Calls one of Hearth's own endpoints outside the actions (/api/devices, /api/push). Fails the way
 * actions do: out of reach, signed out, or Hearth's own words for what went wrong.
 */
export async function request<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  } catch {
    throw new ApiError(0, "unreachable", UNREACHABLE);
  }
  if (res.status === 401) onSignedOut();
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (res.ok) return (body ?? {}) as T;
  if (!body?.error && res.status >= 502) throw new ApiError(res.status, "unreachable", UNREACHABLE);
  throw new ApiError(res.status, "failed", body?.error || res.statusText || "That didn't work.");
}

export async function authPost<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await post(`/api/auth/${path}`, body);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, "auth", data.error ?? res.statusText);
  return data;
}

export interface Me {
  signedIn: boolean;
  principal: string | null;
  needsSetup: boolean;
  /** Hearth's own address, where your passkeys work (D69). Missing from an older Hearth. */
  origin?: string;
  /** Whether the window on this PC has a Windows Hello passkey of its own. */
  localPasskey?: boolean;
}

/**
 * Who you are. Throws when Hearth can't answer (it's restarting, the PC is out of reach, or a
 * proxy sent back an error page), so the app can say so and try again.
 */
export async function getMe(): Promise<Me> {
  const res = await fetch("/api/auth/me", {
    credentials: "same-origin",
    signal: AbortSignal.timeout(10_000),
  });
  const body = res.ok ? ((await res.json().catch(() => null)) as Me | null) : null;
  if (!body || typeof body.signedIn !== "boolean") {
    throw new ApiError(res.status, "unreachable", "Can't reach Hearth.");
  }
  return body;
}
