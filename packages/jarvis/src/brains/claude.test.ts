// ClaudeBrain against a stand-in for the Agent SDK: how a failed API call is read (D54).
import { Registry } from "@hearth/kernel";
import { ALL_MODULES } from "@hearth/modules";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BrainEvents, BrainRequest, BrainTool } from "../brain.ts";
import { BrainError } from "../failures.ts";
import { ClaudeBrain, requestToolOrder, toolAt } from "./claude.ts";
import { forModel } from "./schema.ts";

const sdk = vi.hoisted(() => ({
  messages: [] as unknown[],
  thrown: null as Error | null,
  options: null as Record<string, unknown> | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (o: object) => ({ type: "sdk", ...o }),
  tool: (name: string, description: string, shape: unknown) => ({ name, description, shape }),
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options = options;
    return (async function* () {
      for (const m of sdk.messages) yield m;
      if (sdk.thrown) throw sdk.thrown;
    })();
  },
}));

const tool = (name: string): BrainTool => ({
  name,
  description: name,
  input: z.object({ id: z.string().uuid() }),
  run: async () => "ok",
});

function request(over: Partial<BrainRequest> = {}): BrainRequest {
  return {
    system: "You are Jarvis.",
    prompt: "hi",
    lane: "fast",
    tools: [tool("task_create"), tool("note_create"), tool("sheet_save")],
    sessionId: null,
    signal: new AbortController().signal,
    ...over,
  };
}

function events() {
  const said: string[] = [];
  const e: BrainEvents = {
    onText: () => {},
    onMessage: (t) => said.push(t),
    onExternalContent: () => {},
  };
  return { e, said };
}

const init = { type: "system", subtype: "init", session_id: "s1" };
const apiError = (error: string, text: string) => [
  init,
  {
    type: "assistant",
    parent_tool_use_id: null,
    error,
    message: { id: "m1", content: [{ type: "text", text }] },
  },
  { type: "result", subtype: "success", is_error: true, result: text, session_id: "s1" },
];

async function failure(req = request()) {
  const { e, said } = events();
  const err = await new ClaudeBrain().run(req, e).catch((x: unknown) => x);
  expect(err).toBeInstanceOf(BrainError);
  return { err: err as BrainError, said };
}

beforeEach(() => {
  sdk.messages = [];
  sdk.thrown = null;
  sdk.options = null;
});

describe("ClaudeBrain", () => {
  it("names the tool a 400 points at, and never says the error in the conversation", async () => {
    const text =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.2.custom.input_schema: JSON schema is invalid"}}';
    sdk.messages = apiError("invalid_request", text);
    const { err, said } = await failure();
    // WebFetch, WebSearch, then note_create, sheet_save, task_create.
    expect(err).toMatchObject({ kind: "bad_tool", toolIndex: 2, tool: "note_create" });
    expect(said).toEqual([]);
  });

  it("counts without the web tools when they're off", async () => {
    sdk.messages = apiError("invalid_request", "API Error: 400 tools.0.custom.input_schema: bad");
    const { err } = await failure(request({ web: false }));
    expect(err).toMatchObject({ kind: "bad_tool", tool: "note_create" });
  });

  it("reads a usage limit and when it lifts", async () => {
    sdk.messages = [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790000000 } },
      ...apiError("rate_limit", "Claude AI usage limit reached"),
    ];
    const { err } = await failure();
    expect(err).toMatchObject({ kind: "rate_limit", resetsAt: new Date(1790000000 * 1000) });
  });

  it("reads a sign-in problem from the SDK's label", async () => {
    sdk.messages = apiError("authentication_failed", "Invalid API key · Please run /login");
    expect((await failure()).err.kind).toBe("auth");
  });

  it("reads a dead model process", async () => {
    sdk.messages = [init];
    sdk.thrown = new Error("Claude Code process exited with code 1");
    expect((await failure()).err.kind).toBe("crashed");
  });

  it("comes back with what it said last when it runs out of steps, not a failure (B1)", async () => {
    sdk.messages = [
      init,
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m1", content: [{ type: "text", text: "Still on page two." }] },
      },
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 110,
        errors: [],
        session_id: "s1",
      },
    ];
    const { e, said } = events();
    expect(await new ClaudeBrain().run(request({ maxTurns: 110 }), e)).toEqual({
      text: "Still on page two.",
      sessionId: "s1",
      firstTokenMs: null,
      outOfSteps: { steps: 110 },
    });
    expect(sdk.options?.maxTurns).toBe(110);
    expect(said).toEqual(["Still on page two."]);
    // Without a request's own, the brain's default.
    await new ClaudeBrain({ maxTurns: 40 }).run(request(), e);
    expect(sdk.options?.maxTurns).toBe(40);
  });

  it("answers with Sonnet on the fast lane and Opus on the deep one by default", async () => {
    sdk.messages = [
      init,
      { type: "result", subtype: "success", is_error: false, result: "Hi.", session_id: "s1" },
    ];
    const { e } = events();
    expect(await new ClaudeBrain().run(request(), e)).toMatchObject({
      text: "Hi.",
      sessionId: "s1",
    });
    expect(sdk.options?.model).toBe("sonnet");
    await new ClaudeBrain().run(request({ lane: "deep" }), e);
    expect(sdk.options?.model).toBe("opus");
  });
});

describe("the tool order", () => {
  it("puts the built-ins first, then Hearth's tools by name", () => {
    const order = requestToolOrder(["WebSearch", "WebFetch"], ["b", "a"]);
    expect(order).toEqual(["WebFetch", "WebSearch", "mcp__hearth__a", "mcp__hearth__b"]);
    expect(toolAt(order, 2)).toBe("a");
    expect(toolAt(order, 0)).toBe("WebFetch");
    expect(toolAt(order, 9)).toBeNull();
    expect(toolAt(order, null)).toBeNull();
  });
});

describe("tool schemas for the model", () => {
  const actions = new Registry(ALL_MODULES)
    .allActions()
    .filter((a): a is typeof a & { input: z.ZodObject } => a.input instanceof z.ZodObject);
  const schema = (input: z.ZodObject) => JSON.stringify(z.toJSONSchema(z.object(forModel(input))));

  it("leave out the uuid pattern but keep the format and descriptions", () => {
    let ids = 0;
    for (const a of actions) {
      const before = JSON.stringify(z.toJSONSchema(a.input, { io: "input" }));
      const after = schema(a.input);
      expect(after, a.name).not.toContain("[0-9a-fA-F]{8}");
      const formats = (s: string) => s.match(/"format":"uuid"/g)?.length ?? 0;
      expect(formats(after), a.name).toBe(formats(before));
      ids += formats(after);
      for (const d of before.match(/"description":"[^"]*"/g) ?? [])
        expect(after, a.name).toContain(d);
    }
    expect(ids).toBeGreaterThan(20);
  });

  it("are much smaller", () => {
    const size = (f: (i: z.ZodObject) => string) =>
      actions.reduce((n, a) => n + f(a.input).length, 0);
    const before = size((i) => JSON.stringify(z.toJSONSchema(i, { io: "input" })));
    expect(size(schema)).toBeLessThan(before * 0.9);
  });

  it("leave the kernel's own check alone", () => {
    const input = z.object({ id: z.string().uuid(), tags: z.array(z.string().uuid()).optional() });
    forModel(input);
    expect(input.safeParse({ id: "nope" }).success).toBe(false);
  });

  it("still accept what the real schema accepts (the SDK checks the model's copy)", () => {
    const node = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), id: z.string().uuid() }),
      z.object({ type: z.literal("b"), n: z.number().default(1) }),
    ]);
    const model = z.object(forModel(z.object({ nodes: z.array(node) })));
    const id = "0199a3b2-5c4d-7e6f-8a9b-0c1d2e3f4a5b";
    expect(model.parse({ nodes: [{ type: "a", id }, { type: "b" }] })).toEqual({
      nodes: [
        { type: "a", id },
        { type: "b", n: 1 },
      ],
    });
    expect(model.safeParse({ nodes: [{ type: "c" }] }).success).toBe(false);
  });
});
