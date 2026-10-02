// The model behind Jarvis, behind one small interface: the Claude Agent SDK in production, a
// scripted brain in tests.
import type { ModelImage } from "@hearth/kernel";
import type { z } from "zod";

export type Lane = "fast" | "deep";

export interface BrainTool {
  /** Tool name, e.g. "task_create" (the action name with dots as underscores). */
  name: string;
  description: string;
  input: z.ZodObject;
  /** Runs the tool and returns what the model gets back. Never throws. */
  run(input: unknown): Promise<ToolReply>;
}

/** Text for the model, and sometimes pictures to look at (a screenshot of a page). */
export type ToolReply = string | { text: string; images: ModelImage[] };

export function replyText(reply: ToolReply): string {
  return typeof reply === "string" ? reply : reply.text;
}

export interface BrainRequest {
  system: string;
  prompt: string;
  lane: Lane;
  tools: BrainTool[];
  /** Agent session to resume, so a conversation keeps its context across turns. */
  sessionId: string | null;
  signal: AbortSignal;
}

export interface BrainEvents {
  /** A streamed piece of the reply. */
  onText(delta: string): void;
  /** A complete block of reply text. */
  onMessage(text: string): void;
  /**
   * The model read outside content (the web), so the rest of the turn is untrusted. `text` is
   * what it read, so addresses in it can be followed later (D25).
   */
  onExternalContent(source: string, text?: string): void;
  /** Before a web fetch: null to allow it, or why it's refused (D25). */
  mayFetch?(url: string): string | null;
}

export interface BrainResult {
  text: string;
  sessionId: string | null;
  firstTokenMs: number | null;
}

export interface Brain {
  readonly name: string;
  run(req: BrainRequest, events: BrainEvents): Promise<BrainResult>;
}
