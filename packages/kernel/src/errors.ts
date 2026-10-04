export type ActionErrorCode =
  | "unknown_action"
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "unavailable"
  | "failed";

/** An expected failure an action reports to its caller (not a bug). */
export class ActionError extends Error {
  readonly code: ActionErrorCode;
  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ActionError";
  }
}

export function notFound(what: string): ActionError {
  return new ActionError("not_found", `${what} not found`);
}

export const DATABASE_DOWN = "Hearth's database isn't reachable right now. Try again in a moment.";

interface Failure {
  message?: unknown;
  code?: unknown;
  errno?: unknown;
  cause?: unknown;
  query?: unknown;
  severity?: unknown;
}

/** The error and everything it wraps, outermost first. */
function chain(err: unknown): Failure[] {
  const out: Failure[] = [];
  let e = err;
  while (e && typeof e === "object" && out.length < 8) {
    out.push(e as Failure);
    e = (e as Failure).cause;
  }
  return out;
}

// Postgres refusing connections: class 08 (connection exception), admin or crash shutdown,
// "cannot connect now" while it starts, and too many connections.
const PG_DOWN = /^(08|57P0[1-3]$|53300$)/;
const NET_DOWN = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const DRIVER_DOWN =
  /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Client was closed and is not queryable|Cannot use a pool after calling end/i;

/** A request to another site that failed (Node's fetch). */
const isFetchFailure = (e: Failure) => e instanceof TypeError && e.message === "fetch failed";

/** Whether this failure is the database being out of reach, not something wrong with the call. */
export function isDatabaseDown(err: unknown): boolean {
  for (const e of chain(err)) {
    // The network codes inside a failed fetch are about the site it called (Google, GitHub,
    // Slack out of reach), not the database.
    if (isFetchFailure(e)) return false;
    const code = typeof e.code === "string" ? e.code : "";
    if (NET_DOWN.has(code)) return true;
    // Postgres's own codes come with a severity; a bare code could be anything's.
    if (typeof e.severity === "string" && PG_DOWN.test(code)) return true;
    if (typeof e.message === "string" && DRIVER_DOWN.test(e.message)) return true;
  }
  return false;
}

/**
 * Postgres's own reason, from inside an ORM or driver error. A value Postgres couldn't read
 * ('invalid input syntax for type uuid: "…"') is left out: it's whatever the call carried.
 */
function postgresReason(err: unknown): { message: string; code: string } | null {
  for (const e of chain(err)) {
    if (typeof e.severity === "string" && typeof e.message === "string") {
      const message = e.message.replace(/^(invalid input (?:syntax|value) for [^:]+): .*$/s, "$1");
      return { message, code: typeof e.code === "string" ? e.code : "" };
    }
  }
  return null;
}

/**
 * What a failure means, in words safe to show a person or a model and to keep in the audit log:
 * the database's reason without the query's parameters, which may hold anything the call carried.
 */
export function describeError(err: unknown): { code: ActionErrorCode; message: string } {
  if (err instanceof ActionError) return { code: err.code, message: err.message };
  if (isDatabaseDown(err)) return { code: "unavailable", message: DATABASE_DOWN };
  const pg = postgresReason(err);
  if (pg) return { code: "failed", message: pg.code ? `${pg.message} (${pg.code})` : pg.message };
  const message = err instanceof Error ? err.message : String(err);
  return { code: "failed", message: message.split(/\n?params: /)[0]! };
}

/** One line for a log: the safe description, plus which query failed when there was one. */
export function logLine(err: unknown): string {
  const { message } = describeError(err);
  const query = chain(err).find((e) => typeof e.query === "string")?.query as string | undefined;
  return query ? `${message} [query: ${query.slice(0, 300)}]` : message;
}
