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

async function post(path: string, body: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    credentials: "same-origin",
  });
  if (res.status === 401) onSignedOut();
  return res;
}

/** Runs an action and returns its full result, including approvals and denials. */
export async function runAction<T>(name: string, input: unknown = {}): Promise<ActionResult<T>> {
  const res = await post(`/api/actions/${name}`, input);
  const body = (await res.json().catch(() => null)) as ActionResult<T> | { error: string } | null;
  if (!body || !("status" in body)) {
    throw new ApiError(
      res.status,
      "failed",
      (body as { error?: string } | null)?.error ?? res.statusText,
    );
  }
  return body;
}

/** Runs an action and returns its result, or throws. */
export async function action<T>(name: string, input: unknown = {}): Promise<T> {
  const r = await runAction<T>(name, input);
  if (r.status === "ok") return r.result;
  if (r.status === "pending_approval") throw new ApiError(202, "pending_approval", r.summary);
  if (r.status === "denied") throw new ApiError(403, "denied", r.reason);
  throw new ApiError(400, r.code, r.message);
}

export async function decideApproval(id: string, decision: "approve" | "deny") {
  const res = await post(`/api/approvals/${id}`, { decision });
  return (await res.json()) as ActionResult<unknown>;
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

export async function getMe(): Promise<Me> {
  const res = await fetch("/api/auth/me", { credentials: "same-origin" });
  return (await res.json()) as Me;
}
