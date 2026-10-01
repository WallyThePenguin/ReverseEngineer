// The reflex engine: reads every event once, in order, from its own cursor, and runs the
// reflexes and routines that match. This is what makes Jarvis reactive and proactive across
// every module (PLAN.md section 6.1).
import {
  type DigestSection,
  getCursor,
  getSetting,
  type HearthEvent,
  type Kernel,
  type ReadContext,
  type ReflexDef,
  type ReflexOutcome,
  readEventsAfter,
  setCursor,
} from "@hearth/kernel";
import { HEARTBEAT, runHeartbeat } from "./heartbeat.ts";
import { applyOutcomes, type OutcomeSource } from "./outcomes.ts";

export const ENGINE_CURSOR = "jarvis.reflexes";

export interface EngineOptions {
  kernel: Kernel;
  log?: (msg: string, err?: unknown) => void;
  /** Called after turns are queued, so the runner can start right away. */
  onTurnQueued?: () => void;
}

export class ReflexEngine {
  private readonly kernel: Kernel;
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly onTurnQueued: () => void;
  private busy: Promise<number> | null = null;

  constructor(opts: EngineOptions) {
    this.kernel = opts.kernel;
    this.log = opts.log ?? ((m, e) => console.error(`[jarvis] ${m}`, e ?? ""));
    this.onTurnQueued = opts.onTurnQueued ?? (() => {});
  }

  /** Processes every event after the cursor. Safe to call often; runs are serialized. */
  processAvailable(): Promise<number> {
    if (this.busy) return this.busy.then(() => this.processAvailable());
    this.busy = this.drain().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const cursor = await getCursor(this.kernel.db, ENGINE_CURSOR);
      const events = await readEventsAfter(this.kernel.db, cursor, { limit: 100 });
      if (events.length === 0) return total;
      for (const event of events) {
        await this.handle(event);
        await setCursor(this.kernel.db, ENGINE_CURSOR, event.seq);
        total++;
      }
    }
  }

  private ctx(): ReadContext {
    return { db: this.kernel.db, now: this.kernel.clock.now() };
  }

  async handle(event: HearthEvent): Promise<void> {
    if (event.kind === "clock.fired") await this.handleClock(event);
    const paused = await getSetting(this.kernel.db, "jarvis.paused");
    for (const reflex of this.kernel.registry.reflexesFor(event.kind)) {
      if (event.actor === "jarvis" && !reflex.includeJarvisEvents) continue;
      if (paused && reflex.mode === "proactive") continue;
      await this.runReflex(reflex, event, () => reflex.run(event, this.ctx()));
    }
  }

  private async runReflex(
    reflex: Pick<ReflexDef, "name" | "mode">,
    event: HearthEvent,
    decide: () => Promise<ReflexOutcome[]> | ReflexOutcome[],
  ): Promise<void> {
    let outcomes: ReflexOutcome[];
    try {
      outcomes = await decide();
    } catch (err) {
      this.log(`reflex ${reflex.name} failed on ${event.kind} #${event.seq}`, err);
      return;
    }
    if (outcomes.length === 0) return;
    const src: OutcomeSource = { event, name: reflex.name, mode: reflex.mode };
    try {
      const res = await applyOutcomes(this.kernel, outcomes, src, (m) => this.log(m));
      if (res.turnsQueued > 0) this.onTurnQueued();
    } catch (err) {
      this.log(`applying ${reflex.name} outcomes failed`, err);
    }
  }

  private async handleClock(event: HearthEvent): Promise<void> {
    const p = event.payload;
    if (p.kind === "check") {
      const reflex = this.kernel.registry.reflex(String(p.reflex));
      if (!reflex?.onCheck) return;
      if (reflex.mode === "proactive" && (await getSetting(this.kernel.db, "jarvis.paused")))
        return;
      await this.runReflex(reflex, event, () => reflex.onCheck!(p, { ...this.ctx(), event }));
      return;
    }
    if (p.kind !== "routine") return;
    const name = String(p.routine);
    if (name === HEARTBEAT.name) {
      await this.runReflex({ name, mode: "proactive" }, event, () =>
        runHeartbeat(this.kernel, event),
      );
      return;
    }
    const routine = this.kernel.registry.allRoutines().get(name);
    if (!routine) return;
    const scheduledFor = new Date(String(p.scheduledFor));
    await this.runReflex({ name, mode: "proactive" }, event, () =>
      routine.run({ scheduledFor, event, digest: (since) => this.digest(since) }, this.ctx()),
    );
  }

  /** Every module's digest since a time: the raw material of the brief and the journal. */
  async digest(since: Date): Promise<DigestSection[]> {
    const out: DigestSection[] = [];
    for (const m of this.kernel.registry.modules) {
      if (!m.digest) continue;
      try {
        const items = await m.digest({ ...this.ctx(), since });
        if (items.length) out.push({ module: m.name, items });
      } catch (err) {
        this.log(`digest for ${m.name} failed`, err);
      }
    }
    return out;
  }
}
