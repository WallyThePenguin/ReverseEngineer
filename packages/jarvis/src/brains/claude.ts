// Jarvis on the Claude Agent SDK, logged in through your claude CLI (Max subscription, no API
// key). Hearth's actions are the only tools, plus web search and fetch, whose results mark the
// rest of the turn as untrusted. An untrusted turn's fetches are checked first (D25).
import {
  createSdkMcpServer,
  type HookCallback,
  query,
  type SDKMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type Brain,
  type BrainEvents,
  type BrainRequest,
  type BrainResult,
  replyText,
} from "../brain.ts";

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

/** The text of a tool result block, whatever shape its content takes. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}

/**
 * Follows web tool calls through the stream: a turn turns untrusted once a result comes back,
 * with the addresses in it remembered. A call whose result never shows up still counts by the
 * time the model speaks again.
 */
export function webTracker(events: Pick<BrainEvents, "onExternalContent">) {
  // Tool call id -> tool name and the model message it came in. One model message can arrive as
  // several stream messages (one per block), so only a new message id means the model moved on.
  const pending = new Map<string, { name: string; messageId: string }>();
  return (msg: SDKMessage) => {
    if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      const messageId = msg.message.id;
      for (const [id, call] of pending) {
        if (call.messageId === messageId) continue;
        events.onExternalContent(call.name);
        pending.delete(id);
      }
      for (const block of msg.message.content) {
        if (block.type === "tool_use" && WEB_TOOLS.includes(block.name))
          pending.set(block.id, { name: block.name, messageId });
        if (block.type === "web_search_tool_result")
          events.onExternalContent("WebSearch", resultText(block.content));
      }
    }
    if (
      msg.type === "user" &&
      msg.parent_tool_use_id === null &&
      Array.isArray(msg.message.content)
    ) {
      for (const block of msg.message.content) {
        if (block.type !== "tool_result") continue;
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);
        events.onExternalContent(call.name, resultText(block.content));
      }
    }
  };
}

/** Refuses a web fetch the turn isn't allowed to make (D25). */
export function fetchGuard(events: Pick<BrainEvents, "mayFetch">): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const url = (input.tool_input as { url?: unknown } | null)?.url;
    const refused = events.mayFetch?.(typeof url === "string" ? url : "") ?? null;
    if (!refused) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: refused,
      },
    };
  };
}

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
        tool(t.name, t.description, t.input.shape, async (args) => {
          const reply = await t.run(args);
          const text = { type: "text" as const, text: replyText(reply) };
          if (typeof reply === "string") return { content: [text] };
          const images = reply.images.map((i) => ({
            type: "image" as const,
            data: i.data,
            mimeType: i.mimeType,
          }));
          return { content: [text, ...images] };
        }),
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
        hooks: { PreToolUse: [{ matcher: "WebFetch", hooks: [fetchGuard(events)] }] },
        ...(req.sessionId ? { resume: req.sessionId } : {}),
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "hearth/0.1" },
      },
    });

    const trackWeb = webTracker(events);
    for await (const msg of q) {
      trackWeb(msg);
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
