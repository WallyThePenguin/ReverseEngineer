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

async function post(path: string, body: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
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
export async function runAction<T>(name: string, input: unknown = {}): Promise<ActionResult<T>> {
  return resultOf<T>(await post(`/api/actions/${name}`, input));
}

/** Runs an action and returns its result, or throws. */
export async function action<T>(name: string, input: unknown = {}): Promise<T> {
  const r = await runAction<T>(name, input);
  if (r.status === "ok") return r.result;
  if (r.status === "pending_approval") throw new ApiError(202, "pending_approval", r.summary);
  if (r.status === "denied") throw new ApiError(403, "denied", r.reason);
  throw new ApiError(400, r.code, r.message);
}

/** Approves or denies. Throws, like runAction, when Hearth can't give an answer. */
export async function decideApproval(id: string, decision: "approve" | "deny") {
  return resultOf<unknown>(await post(`/api/approvals/${id}`, { decision }));
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
