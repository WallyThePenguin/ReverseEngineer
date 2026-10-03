// Recorded turns: what a model did in a turn (its tool calls, what it read on the web, what it
// said), saved as a fixture and played back later. CI replays fixtures so a change to Hearth's
// tools, prompts or guardrails that would change their outcome fails the build without a model.
//
// Record ids differ from run to run, so a fixture names records by type and title instead:
// "@{event:Budget review}". Recording swaps ids for these; replay swaps them back just before
// each call, so a record made earlier in the same turn resolves too.
import type { DbOrTx } from "@hearth/db";
import { entity } from "@hearth/db";
import { and, desc, eq } from "drizzle-orm";
import type { Brain, BrainEvents, BrainRequest, BrainResult } from "../brain.ts";
import { replyText } from "../brain.ts";
import type { ScriptStep } from "../brains/scripted.ts";

export interface RecordedTurn {
  /** The start of the turn's prompt, to catch a fixture played against the wrong turn. */
  promptStart: string;
  steps: ScriptStep[];
}

export interface Fixture {
  scenario: string;
  /** "hand" for seeded fixtures, or the model that recorded it live. */
  recordedWith: string;
  recordedAt: string;
  turns: RecordedTurn[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^@\{([a-z_]+):(.*)\}$/s;

async function mapStrings(value: unknown, fn: (s: string) => Promise<string>): Promise<unknown> {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return Promise.all(value.map((v) => mapStrings(v, fn)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await mapStrings(v, fn);
    return out;
  }
  return value;
}

export function toRefs(db: DbOrTx, input: unknown): Promise<unknown> {
  return mapStrings(input, async (s) => {
    if (!UUID.test(s)) return s;
    const [row] = await db
      .select({ type: entity.type, title: entity.title })
      .from(entity)
      .where(eq(entity.id, s));
    return row ? `@{${row.type}:${row.title}}` : s;
  });
}

export function fromRefs(db: DbOrTx, input: unknown): Promise<unknown> {
  return mapStrings(input, async (s) => {
    const m = s.match(REF);
    if (!m) return s;
    const [row] = await db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.type, m[1]!), eq(entity.title, m[2]!)))
      .orderBy(desc(entity.createdAt))
      .limit(1);
    if (!row) throw new Error(`Fixture refers to ${s}, which doesn't exist in this run.`);
    return row.id;
  });
}

/** Wraps a real brain and keeps what each turn did. Set `db` before turns run. */
export class RecordingBrain implements Brain {
  readonly name: string;
  readonly turns: RecordedTurn[] = [];
  readonly requests: BrainRequest[] = [];
  db: DbOrTx | null = null;
  private readonly inner: Brain;

  constructor(inner: Brain) {
    this.inner = inner;
    this.name = `recording(${inner.name})`;
  }

  async run(req: BrainRequest, events: BrainEvents): Promise<BrainResult> {
    this.requests.push(req);
    const steps: ScriptStep[] = [];
    const db = this.db;
    const tools = req.tools.map((t) => ({
      ...t,
      async run(input: unknown) {
        // Resolve refs before the call runs: the call may create or trash what they name.
        steps.push({ call: t.name, input: db ? await toRefs(db, input) : input });
        return t.run(input);
      },
    }));
    const result = await this.inner.run(
      { ...req, tools },
      {
        ...events,
        onExternalContent(source, text) {
          steps.push({ readWeb: source, ...(text === undefined ? {} : { text }) });
          events.onExternalContent(source, text);
        },
      },
    );
    if (result.text) steps.push({ say: result.text });
    this.turns.push({ promptStart: req.prompt.slice(0, 60), steps });
    return result;
  }
}

/** Plays a fixture's turns back in order. Set `db` before turns run. */
export class ReplayBrain implements Brain {
  readonly name = "replay";
  readonly requests: BrainRequest[] = [];
  db: DbOrTx | null = null;
  private next = 0;
  private readonly fixture: Fixture;

  constructor(fixture: Fixture) {
    this.fixture = fixture;
  }

  async run(req: BrainRequest, events: BrainEvents): Promise<BrainResult> {
    this.requests.push(req);
    const turn = this.fixture.turns[this.next++];
    const name = this.fixture.scenario;
    if (!turn) throw new Error(`Fixture ${name} has no recording for turn ${this.next}.`);
    if (!req.prompt.startsWith(turn.promptStart))
      throw new Error(
        `Fixture ${name} expected a turn starting "${turn.promptStart}", got "${req.prompt.slice(0, 60)}"`,
      );
    const said: string[] = [];
    for (const step of turn.steps) {
      if ("say" in step) {
        events.onText(step.say);
        events.onMessage(step.say);
        said.push(step.say);
      } else if ("readWeb" in step) {
        events.onExternalContent(step.readWeb, step.text);
      } else if ("call" in step) {
        const tool = req.tools.find((t) => t.name === step.call);
        if (!tool)
          throw new Error(`Fixture ${name} calls a tool that no longer exists: ${step.call}`);
        replyText(await tool.run(this.db ? await fromRefs(this.db, step.input) : step.input));
      }
    }
    return { text: said.join("\n\n"), sessionId: req.sessionId ?? "replay", firstTokenMs: 1 };
  }

  /** Turns in the fixture that never ran: the scenario took a different path. */
  get unplayed(): number {
    return Math.max(0, this.fixture.turns.length - this.next);
  }
}
