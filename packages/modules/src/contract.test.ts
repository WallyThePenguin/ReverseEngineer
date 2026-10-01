import { checkJarvisContract, Registry } from "@hearth/kernel";
import { describe, expect, it } from "vitest";
import { ALL_MODULES } from "./index.ts";

describe("the Jarvis contract", () => {
  const registry = new Registry(ALL_MODULES);

  it("holds for every module: events, actions, knowledge and reflexes", () => {
    expect(checkJarvisContract(registry)).toEqual([]);
  });

  it("gives every action a name that works as a tool name", () => {
    const tools = registry.allActions().map((a) => a.name.replaceAll(".", "_"));
    for (const t of tools) expect(t).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("has Jarvis react to every kind of record a module owns", () => {
    // Each module either has reflexes or routines, or explains why not; none are silent.
    const silent = registry.modules.filter((m) => m.reflexes.length === 0 && !m.routines?.length);
    expect(silent.map((m) => [m.name, Boolean(m.noReflexesBecause)])).toEqual(
      silent.map((m) => [m.name, true]),
    );
  });
});
