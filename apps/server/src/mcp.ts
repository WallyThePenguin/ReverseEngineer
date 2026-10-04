// /mcp: Hearth as an MCP server, so other agents (Claude Code, Claude Desktop) can read and add
// to your workspace. They connect with a token from `hearth token create`, act as their own
// principal, never see send actions, and anything risky waits for your approval.

import { type DbOrTx, principal, session } from "@hearth/db";
import { describeRecord } from "@hearth/jarvis";
import { type Caller, isVisibleTo, type Kernel } from "@hearth/kernel";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { requireCaller } from "./auth/middleware.ts";
import type { AppEnv } from "./env.ts";
import { inputSchema } from "./routes/actions.ts";

const MAX_OUTPUT = 50_000;
const toolName = (action: string) => action.replaceAll(".", "_");

function text(value: string, isError = false) {
  const body = value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n[cut off]` : value;
  return { content: [{ type: "text" as const, text: body }], isError };
}

export function buildMcpServer(kernel: Kernel, caller: Caller): Server {
  const server = new Server(
    { name: "hearth", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Hearth is the owner's personal workspace (tasks, notes, people, inbox). Read freely. Writes are recorded under your name; risky ones wait for the owner's approval.",
    },
  );
  const actions = kernel.registry.allActions().filter((a) => isVisibleTo(a, caller.kind));
  const byTool = new Map(actions.map((a) => [toolName(a.name), a]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...actions.map((a) => ({
        name: toolName(a.name),
        description: a.description,
        inputSchema: { type: "object" as const, ...inputSchema(a.input) },
      })),
      {
        name: "record_read",
        description: "Read any record in Hearth by id: its contents and what links to it.",
        inputSchema: {
          type: "object" as const,
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    if (req.params.name === "record_read") {
      const id = typeof args.id === "string" ? args.id : "";
      // Through entity.get first, so a record this agent can't read (memory: D58) isn't found.
      const visible = await kernel.execute("entity.get", { id }, caller);
      const found =
        visible.status === "ok" ? await describeRecord(kernel, id, caller).catch(() => null) : null;
      return text(found ?? "No record with that id.", !found);
    }
    const def = byTool.get(req.params.name);
    if (!def) return text(`No tool named ${req.params.name}.`, true);
    const result = await kernel.execute(def.name, args, caller);
    switch (result.status) {
      case "ok":
        return text(JSON.stringify(result.result ?? null));
      case "pending_approval":
        return text(
          `Waiting for the owner's approval in Hearth: ${result.summary} (approval ${result.approvalId}).`,
        );
      case "denied":
        return text(`Not allowed: ${result.reason}`, true);
      case "error":
        return text(`${result.code}: ${result.message}`, true);
    }
  });
  return server;
}

/** Whether you've made a token for an outside agent that still works: until then, /mcp is off. */
async function mcpEnabled(db: DbOrTx): Promise<boolean> {
  const [live] = await db
    .select({ id: session.tokenHash })
    .from(session)
    .innerJoin(principal, eq(principal.id, session.principal))
    .where(
      and(
        eq(session.kind, "api"),
        eq(principal.kind, "mcp_client"),
        isNull(session.revokedAt),
        isNull(principal.disabledAt),
      ),
    )
    .limit(1);
  return Boolean(live);
}

export function mcpRoutes() {
  const app = new Hono<AppEnv>();
  // Off until you make a token with `hearth token create`: until then there's nothing to find.
  app.use("*", async (c, next) => {
    if (!(await mcpEnabled(c.get("deps").kernel.db)))
      return c.json(
        { error: "Hearth's MCP server is off. Run `hearth token create <name>` to turn it on." },
        404,
      );
    await next();
  });
  // Stateless JSON over POST: there's no event stream to open with GET, nor a session to end.
  app.on(["GET", "PUT", "PATCH", "DELETE"], "/", (c) =>
    c.json({ error: "Use POST." }, 405, { Allow: "POST" }),
  );
  app.post("/", requireCaller(["mcp_client"]), async (c) => {
    const { kernel } = c.get("deps");
    // Stateless: a fresh server and transport per request, so restarts never strand a client.
    const server = buildMcpServer(kernel, c.get("caller")!);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
  return app;
}
