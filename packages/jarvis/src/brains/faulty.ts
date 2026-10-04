// A brain for fault-injection tests: each call either fails the way Claude does (a rejected
// tool, a 500, a usage limit, a dead or hung process) or hands over to a scripted brain.
import type { Brain, BrainEvents, BrainRequest, BrainResult } from "../brain.ts";
import { BrainError } from "../failures.ts";
import { requestToolOrder, toolAt } from "./claude.ts";
import type { ScriptedBrain } from "./scripted.ts";

/** An error to throw for this call, or "hang" for a call that never returns. */
export type Fault = (req: BrainRequest) => Error | "hang";

export class FaultyBrain implements Brain {
  readonly name = "faulty";
  readonly requests: BrainRequest[] = [];
  private readonly faults: Fault[] = [];
  readonly inner: ScriptedBrain;

  constructor(inner: ScriptedBrain) {
    this.inner = inner;
  }

  /** Queues faults for the next calls, in order; once they run out, the script answers. */
  fail(...faults: Fault[]): this {
    this.faults.push(...faults);
    return this;
  }

  async run(req: BrainRequest, events: BrainEvents): Promise<BrainResult> {
    this.requests.push(req);
    const fault = this.faults.shift();
    if (!fault) return this.inner.run(req, events);
    const err = fault(req);
    // Ignores the abort signal too, like a stuck process would.
    if (err === "hang") return new Promise<never>(() => {});
    throw err;
  }
}

const WEB = ["WebFetch", "WebSearch"];

/** Claude rejecting one tool's schema, named by its place in the request, as the API does. */
export const rejectTool =
  (name: string): Fault =>
  (req) => {
    const order = requestToolOrder(
      req.web === false ? [] : WEB,
      req.tools.map((t) => t.name),
    );
    const index = order.indexOf(`mcp__hearth__${name}`);
    const detail = `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.${index}.custom.input_schema: JSON schema is invalid"}}`;
    return new BrainError("bad_tool", `Jarvis's model turn failed: ${detail}`, {
      toolIndex: index,
      tool: toolAt(order, index),
    });
  };

export const serverError: Fault = () =>
  new Error(
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
  );

/** The owner's usage limit, lifting at `resetsAt`. */
export const usageLimit =
  (resetsAt: Date): Fault =>
  () =>
    new Error(`Claude AI usage limit reached|${Math.floor(resetsAt.getTime() / 1000)}`);

export const killed: Fault = () => new Error("Claude Code process exited with code 143");

export const hung: Fault = () => "hang";

export const sessionGone: Fault = (req) =>
  new Error(`No conversation found with session ID: ${req.sessionId}`);
