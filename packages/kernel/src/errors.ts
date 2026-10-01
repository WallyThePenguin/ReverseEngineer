export type ActionErrorCode =
  | "unknown_action"
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "forbidden"
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
