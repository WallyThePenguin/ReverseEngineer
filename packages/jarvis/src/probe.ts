// A live check that Claude accepts every tool Jarvis sends (D54): one cheap call carrying the
// full tool list, built the way a turn builds it. The API checks every tool's schema on every
// request, so one bad definition fails all of Jarvis's turns; this finds it before a turn does.
// live-probe.test.ts runs it when HEARTH_LIVE_PROBE=1.
import { DEFAULT_SITE_RULES } from "@hearth/core";
import { type Kernel, newId } from "@hearth/kernel";
import type { Brain, BrainTool } from "./brain.ts";
import { ClaudeBrain } from "./brains/claude.ts";
import { classifyFailure, type Failure } from "./failures.ts";
import { buildTools } from "./tools.ts";

export type ProbeResult =
  | { ok: true; tools: number }
  | { ok: false; tools: number; failure: Failure };

export async function probeToolSchemas(
  kernel: Kernel,
  opts: { brain?: Brain; extraTools?: BrainTool[]; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const id = newId();
  const tools = [
    ...buildTools(
      kernel,
      {
        turnId: id,
        conversationId: id,
        subjectId: null,
        origin: "owner",
        causationId: null,
        calls: [],
        postedToSubject: false,
        seenUrls: new Set(),
        sites: DEFAULT_SITE_RULES,
      },
      async () => {},
    ),
    ...(opts.extraTools ?? []),
  ];
  // The cheapest model, and one turn: the answer doesn't matter, only that the request is taken.
  const brain =
    opts.brain ?? new ClaudeBrain({ models: { fast: "haiku", deep: "haiku" }, maxTurns: 1 });
  try {
    await brain.run(
      {
        system: "This is a quick check that your tools load. Don't use any of them.",
        prompt: "Reply with just: OK",
        lane: "fast",
        tools,
        sessionId: null,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      },
      { onText: () => {}, onMessage: () => {}, onExternalContent: () => {} },
    );
    return { ok: true, tools: tools.length };
  } catch (err) {
    return { ok: false, tools: tools.length, failure: classifyFailure(err) };
  }
}
