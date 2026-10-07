// The action API: every screen and script does everything through POST /api/actions/:name,
// which runs through the same kernel, policy and audit trail as Jarvis.
import { isUuid } from "@hearth/core";
import type { Caller, ExecuteResult, Kernel } from "@hearth/kernel";
import { isVisibleTo } from "@hearth/kernel";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { ActionTimings } from "../action-timing.ts";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv } from "../env.ts";

const STATUS_FOR_ERROR: Record<string, ContentfulStatusCode> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  unknown_action: 404,
  conflict: 409,
  unavailable: 503,
  failed: 500,
};

export function httpStatus(result: ExecuteResult): ContentfulStatusCode {
  switch (result.status) {
    case "ok":
      return 200;
    case "pending_approval":
      return 202;
    case "denied":
      return 403;
    case "error":
      return STATUS_FOR_ERROR[result.code] ?? 500;
  }
}

/** The actions a caller may see, with JSON Schemas for their inputs. */
export function listActions(kernel: Kernel, caller: Caller) {
  return kernel.registry
    .allActions()
    .filter((a) => isVisibleTo(a, caller.kind))
    .map((a) => ({
      name: a.name,
      description: a.description,
      risk: a.risk,
      input: inputSchema(a.input),
    }));
}

export function inputSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
  } catch {
    return { type: "object" };
  }
}

const INVALID = Symbol("invalid");

function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return INVALID;
  }
}

const decisionBody = z.object({
  decision: z.enum(["approve", "deny"]),
  /** Always allow (D70): the yes also writes the card's rule. */
  alwaysAllow: z.boolean().optional(),
});

export function actionRoutes(timings?: ActionTimings) {
  const app = new Hono<AppEnv>();
  app.use("*", requireCaller());

  app.get("/actions", (c) => {
    const { kernel } = c.get("deps");
    return c.json({ actions: listActions(kernel, c.get("caller")!) });
  });

  app.post("/actions/:name", async (c) => {
    const { kernel } = c.get("deps");
    const input = parseJson(await c.req.text());
    if (input === INVALID) {
      return c.json({ status: "error", code: "invalid_input", message: "Body must be JSON." }, 400);
    }
    // Stored as a UUID: anything else would fail the action at the database, so it's ignored.
    const correlation = c.req.header("x-correlation-id");
    const caller = {
      ...c.get("caller")!,
      correlationId: correlation && isUuid(correlation) ? correlation : undefined,
    };
    const name = c.req.param("name");
    const started = performance.now();
    const result = await kernel.execute(name, input, caller);
    // Only actions that exist: a made-up name isn't kept.
    if (result.status !== "error" || result.code !== "unknown_action")
      timings?.record(name, performance.now() - started);
    return c.json(result, httpStatus(result));
  });

  app.post("/approvals/:id", requireCaller(["owner"]), async (c) => {
    const { kernel } = c.get("deps");
    const body = decisionBody.safeParse(parseJson(await c.req.text()));
    if (!body.success)
      return c.json(
        { status: "error", code: "invalid_input", message: "decision must be approve or deny" },
        400,
      );
    const result = await kernel.decideApproval(
      c.req.param("id"),
      body.data.decision,
      c.get("caller")!,
      { alwaysAllow: body.data.alwaysAllow === true },
    );
    return c.json(result, httpStatus(result));
  });

  return app;
}
