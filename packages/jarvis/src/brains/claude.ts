// Jarvis on the Claude Agent SDK, logged in through your claude CLI (Max subscription, no API
// key). Hearth's actions are the only tools, plus web search and fetch, which mark the rest of
// the turn as untrusted.
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Brain, BrainEvents, BrainRequest, BrainResult } from "../brain.ts";

export interface ClaudeBrainOptions {
  /** Model per lane. Defaults to the top model for both, per your preference. */
  models?: { fast: string; deep: string };
  /** Allow WebSearch and WebFetch. */
  web?: boolean;
  /** Working directory for the agent process (no file tools are enabled). */
  cwd?: string;
  maxTurns?: number;
}

const WEB_TOOLS = ["WebSearch", "WebFetch"];

export class ClaudeBrain implements Brain {
  readonly name = "claude";
  private readonly opts: Required<Omit<ClaudeBrainOptions, "cwd">> & { cwd?: string };

  constructor(opts: ClaudeBrainOptions = {}) {
    this.opts = {
      models: opts.models ?? { fast: "opus", deep: "opus" },
      web: opts.web ?? true,
      maxTurns: opts.maxTurns ?? 40,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    };
  }

  async run(req: BrainRequest, events: BrainEvents): Promise<BrainResult> {
    const server = createSdkMcpServer({
      name: "hearth",
      version: "0.1.0",
      alwaysLoad: true,
      tools: req.tools.map((t) =>
        tool(t.name, t.description, t.input.shape, async (args) => ({
          content: [{ type: "text" as const, text: await t.run(args) }],
        })),
      ),
    });
    const builtIn = this.opts.web ? WEB_TOOLS : [];
    const abort = new AbortController();
    req.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const started = performance.now();
    let firstTokenMs: number | null = null;
    let sessionId: string | null = req.sessionId;
    let finalText = "";

    const q = query({
      prompt: req.prompt,
      options: {
        systemPrompt: req.system,
        model: req.lane === "deep" ? this.opts.models.deep : this.opts.models.fast,
        mcpServers: { hearth: server },
        tools: builtIn,
        allowedTools: [...builtIn, ...req.tools.map((t) => `mcp__hearth__${t.name}`)],
        permissionMode: "dontAsk",
        settingSources: [],
        includePartialMessages: true,
        maxTurns: this.opts.maxTurns,
        abortController: abort,
        ...(req.sessionId ? { resume: req.sessionId } : {}),
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "hearth/0.1" },
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
      if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          firstTokenMs ??= Math.round(performance.now() - started);
          events.onText(ev.delta.text);
        }
      }
      if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) events.onMessage(block.text);
          if (
            (block.type === "tool_use" || block.type === "server_tool_use") &&
            WEB_TOOLS.includes(block.name)
          ) {
            events.onExternalContent(block.name);
          }
        }
      }
      if (msg.type === "result") {
        sessionId = msg.session_id;
        if (msg.subtype !== "success" || msg.is_error) {
          const detail = msg.subtype === "success" ? msg.result : msg.subtype;
          throw new Error(`Jarvis's model turn failed: ${detail}`);
        }
        finalText = msg.result;
      }
    }
    return { text: finalText, sessionId, firstTokenMs };
  }
}
