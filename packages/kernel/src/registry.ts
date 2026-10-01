import { KERNEL_EVENTS } from "./kernel-events.ts";
import type {
  ActionDef,
  Describe,
  EventDef,
  HearthModule,
  ReflexDef,
  RoutineDef,
} from "./types.ts";

/** Everything the modules declared, indexed. Built once at startup. */
export class Registry {
  readonly modules: HearthModule[] = [];
  private readonly actions = new Map<string, ActionDef>();
  private readonly events = new Map<string, EventDef>();
  private readonly knowledge = new Map<string, Describe>();
  private readonly routines = new Map<string, RoutineDef>();
  private readonly reflexList: ReflexDef[] = [];

  constructor(modules: HearthModule[] = []) {
    for (const e of KERNEL_EVENTS) this.events.set(e.kind, e);
    for (const m of modules) this.add(m);
  }

  add(module: HearthModule): void {
    if (this.modules.some((m) => m.name === module.name)) {
      throw new Error(`Module ${module.name} registered twice`);
    }
    for (const a of module.actions) {
      if (this.actions.has(a.name)) throw new Error(`Action ${a.name} declared twice`);
      this.actions.set(a.name, a);
    }
    for (const e of module.events) {
      if (this.events.has(e.kind)) throw new Error(`Event ${e.kind} declared twice`);
      this.events.set(e.kind, e);
    }
    for (const [type, describe] of Object.entries(module.knowledge)) {
      if (this.knowledge.has(type)) throw new Error(`Knowledge for ${type} declared twice`);
      this.knowledge.set(type, describe);
    }
    for (const r of module.routines ?? []) {
      const name = `${module.name}.${r.name}`;
      if (this.routines.has(name)) throw new Error(`Routine ${name} declared twice`);
      this.routines.set(name, r);
    }
    for (const r of module.reflexes) {
      if (this.reflexList.some((x) => x.name === r.name))
        throw new Error(`Reflex ${r.name} declared twice`);
      this.reflexList.push(r);
    }
    this.modules.push(module);
  }

  action(name: string): ActionDef | undefined {
    return this.actions.get(name);
  }

  allActions(): ActionDef[] {
    return [...this.actions.values()];
  }

  hasEvent(kind: string): boolean {
    return this.events.has(kind);
  }

  allEvents(): EventDef[] {
    return [...this.events.values()];
  }

  describer(type: string): Describe | undefined {
    return this.knowledge.get(type);
  }

  reflexes(): ReflexDef[] {
    return this.reflexList;
  }

  reflexesFor(kind: string): ReflexDef[] {
    return this.reflexList.filter((r) => r.on.includes(kind) || r.on.includes("*"));
  }

  /** Routines keyed "module.name". */
  allRoutines(): Map<string, RoutineDef> {
    return this.routines;
  }

  reflex(name: string): ReflexDef | undefined {
    return this.reflexList.find((r) => r.name === name);
  }
}

/**
 * The Jarvis contract (PLAN.md section 6.1): every module gives Jarvis senses, hands, knowledge
 * and reflexes. Returns the problems found; the contract test fails if there are any.
 */
export function checkJarvisContract(registry: Registry): string[] {
  const problems: string[] = [];
  for (const m of registry.modules) {
    for (const type of m.entityTypes) {
      if (!m.knowledge[type])
        problems.push(`${m.name}: no knowledge function for entity type "${type}"`);
    }
    const writes = m.actions.filter((a) => a.risk !== "read");
    const senses = m.events.length + (m.kernelEvents?.length ?? 0) + m.entityTypes.length;
    if (writes.length > 0 && senses === 0) {
      problems.push(`${m.name}: has write actions but declares no events`);
    }
    for (const kind of m.kernelEvents ?? []) {
      if (!KERNEL_EVENTS.some((e) => e.kind === kind))
        problems.push(`${m.name}: "${kind}" is not a kernel event`);
    }
    if (m.actions.length === 0) problems.push(`${m.name}: declares no actions`);
    for (const a of m.actions) {
      if (!a.name.includes("."))
        problems.push(`${m.name}: action "${a.name}" is not named module.verb`);
      if (a.description.trim().length < 10)
        problems.push(`${m.name}: action "${a.name}" needs a description`);
    }
    const hasReflexes = m.reflexes.length > 0 || (m.routines?.length ?? 0) > 0;
    if (!hasReflexes && !m.noReflexesBecause) {
      problems.push(`${m.name}: no reflexes or routines, and no reason given`);
    }
    for (const r of m.reflexes) {
      for (const kind of r.on) {
        if (kind !== "*" && !registry.hasEvent(kind))
          problems.push(`${m.name}: reflex "${r.name}" listens to undeclared "${kind}"`);
      }
    }
  }
  return problems;
}
