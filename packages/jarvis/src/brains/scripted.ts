// A brain for tests: each turn follows a script of tool calls and replies, so tests can assert
// exactly what Jarvis did without a model.
import type { Brain, BrainEvents, BrainRequest, BrainResult } from "../brain.ts";

export type ScriptStep =
  | { say: string }
  | { call: string; input: unknown }
  | { readWeb: string; text?: string }
  /** A web fetch: refused or read, and the outcome goes into outputs. */
  | { fetch: string; content?: string };

export type Script = (req: BrainRequest, outputs: string[]) => ScriptStep[] | Promise<ScriptStep[]>;

export class ScriptedBrain implements Brain {
  readonly name = "scripted";
  readonly requests: BrainRequest[] = [];
  private readonly scripts: Script[] = [];
  private fallback: Script = () => [{ say: "OK." }];

  /** Queues a script for the next turn. */
  next(script: Script | ScriptStep[]): this {
    this.scripts.push(Array.isArray(script) ? () => script : script);
    return this;
  }

  /** The script used when nothing is queued. */
  otherwise(script: Script | ScriptStep[]): this {
    this.fallback = Array.isArray(script) ? () => script : script;
    return this;
  }

  async run(req: BrainRequest, events: BrainEvents): Promise<BrainResult> {
    this.requests.push(req);
    const script = this.scripts.shift() ?? this.fallback;
    const outputs: string[] = [];
    const said: string[] = [];
    for (const step of await script(req, outputs)) {
      if ("say" in step) {
        events.onText(step.say);
        events.onMessage(step.say);
        said.push(step.say);
      } else if ("readWeb" in step) {
        events.onExternalContent(step.readWeb, step.text);
      } else if ("fetch" in step) {
        const refused = events.mayFetch?.(step.fetch) ?? null;
        if (refused) outputs.push(`Refused: ${refused}`);
        else {
          events.onExternalContent("WebFetch", step.content ?? "");
          outputs.push(step.content ?? "");
        }
      } else {
        const tool = req.tools.find((t) => t.name === step.call);
        if (!tool) throw new Error(`Script called unknown tool ${step.call}`);
        outputs.push(await tool.run(step.input));
      }
    }
    return {
      text: said.join("\n\n"),
      sessionId: req.sessionId ?? "scripted-session",
      firstTokenMs: 1,
    };
  }
}
