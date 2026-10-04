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
import { BrainError, classifyFailure } from "../failures.ts";
import { forModel } from "./schema.ts";

export interface ClaudeBrainOptions {
  /** Model per lane: Sonnet answers quickly, Opus does the deep work (D54). */
  models?: { fast: string; deep: string };
  /** Allow WebSearch and WebFetch. */
  web?: boolean;
  /**
   * Working directory for the agent process (no file tools are enabled). Claude keeps its
   * sessions per folder, so a fixed one lets a conversation resume after an update (D54).
   */
  cwd?: string;
  maxTurns?: number;
}

const WEB_TOOLS = ["WebSearch", "WebFetch"];
const MCP_PREFIX = "mcp__hearth__";

/**
 * The tools in the order Claude sends them to the API: its built-ins, then the MCP tools by
 * name. An error naming "tools.N" points into this list (checked against the live API in
 * live-probe.test.ts).
 */
export function requestToolOrder(builtIn: string[], tools: string[]): string[] {
  return [...[...builtIn].sort(), ...tools.map((n) => `${MCP_PREFIX}${n}`).sort()];
}

/** The tool an error's "tools.N" points at: a Hearth tool's own name, or a built-in's. */
export function toolAt(order: string[], index: number | null): string | null {
  const name = index === null ? undefined : order[index];
  return name ? name.replace(MCP_PREFIX, "") : null;
}

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
      models: opts.models ?? { fast: "sonnet", deep: "opus" },
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
        tool(t.name, t.description, forModel(t.input), async (args) => {
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
    const builtIn = this.opts.web && req.web !== false ? WEB_TOOLS : [];
    const abort = new AbortController();
    if (req.signal.aborted) abort.abort();
    req.signal.addEventListener("abort", () => abort.abort(), { once: true });
    const started = performance.now();
    let firstTokenMs: number | null = null;
    let sessionId: string | null = req.sessionId;
    let finalText = "";
    // What it said last, which is all there is to show if it runs out of steps (B1).
    let lastSaid = "";
    let outOfSteps: { steps: number } | null = null;

    const q = query({
      prompt: req.prompt,
      options: {
        systemPrompt: req.system,
        model: req.lane === "deep" ? this.opts.models.deep : this.opts.models.fast,
        mcpServers: { hearth: server },
        tools: builtIn,
        allowedTools: [...builtIn, ...req.tools.map((t) => `${MCP_PREFIX}${t.name}`)],
        permissionMode: "dontAsk",
        settingSources: [],
        includePartialMessages: true,
        maxTurns: req.maxTurns ?? this.opts.maxTurns,
        abortController: abort,
        hooks: { PreToolUse: [{ matcher: "WebFetch", hooks: [fetchGuard(events)] }] },
        ...(req.sessionId ? { resume: req.sessionId } : {}),
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "hearth/0.1" },
      },
    });

    // A failed API call comes back as an assistant message holding the error text, labelled
    // with the kind of error. That text is for the log, never for the conversation (D54).
    let sdkKind: string | null = null;
    let resetsAt: Date | null = null;
    const order = requestToolOrder(
      builtIn,
      req.tools.map((t) => t.name),
    );
    const failed = (detail: string): BrainError => {
      const f = classifyFailure(new Error(detail), sdkKind);
      return new BrainError(f.kind, `Jarvis's model turn failed: ${detail}`, {
        resetsAt: f.kind === "rate_limit" ? (resetsAt ?? f.resetsAt) : null,
        toolIndex: f.toolIndex,
        tool: toolAt(order, f.toolIndex),
      });
    };
    const trackWeb = webTracker(events);
    try {
      for await (const msg of q) {
        trackWeb(msg);
        if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
        if (msg.type === "rate_limit_event" && msg.rate_limit_info.status === "rejected") {
          const at = msg.rate_limit_info.resetsAt;
          if (at) resetsAt = new Date(at * 1000);
        }
        if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
          const ev = msg.event;
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            firstTokenMs ??= Math.round(performance.now() - started);
            events.onText(ev.delta.text);
          }
        }
        if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
          if (msg.error) {
            sdkKind = msg.error;
            continue;
          }
          for (const block of msg.message.content) {
            if (block.type !== "text" || !block.text.trim()) continue;
            events.onMessage(block.text);
            lastSaid = block.text;
          }
        }
        if (msg.type === "result") {
          sessionId = msg.session_id;
          if (msg.subtype === "error_max_turns") {
            // Out of steps, not broken: the runner decides whether it gets more.
            outOfSteps = { steps: msg.num_turns };
            finalText = lastSaid;
            continue;
          }
          if (msg.subtype !== "success" || msg.is_error) {
            const detail =
              msg.subtype === "success" ? msg.result : [msg.subtype, ...msg.errors].join(": ");
            throw failed(detail);
          }
          finalText = msg.result;
        }
      }
    } catch (err) {
      // Stopped or out of time: the runner knows which, and says so.
      if (err instanceof BrainError || req.signal.aborted) throw err;
      throw failed(err instanceof Error ? err.message : String(err));
    }
    return { text: finalText, sessionId, firstTokenMs, ...(outOfSteps ? { outOfSteps } : {}) };
  }
}
