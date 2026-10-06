import { checkJarvisContract, isVisibleTo, Registry } from "@hearth/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_MODULES } from "./index.ts";

/** Compiles as a Unicode regex and has no unescaped "[" inside a character class. */
function portablePattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
  } catch {
    return false;
  }
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (c === "[" && inClass) return false;
    else if (c === "[") inClass = true;
    else if (c === "]" && inClass) inClass = false;
  }
  return true;
}

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

  it("gives Jarvis tool schemas whose patterns the model API can compile", () => {
    // The API compiles tool schema patterns with a non-JavaScript regex engine, where an
    // unescaped "[" inside a character class opens a nested class. One such pattern made the
    // API reject every Jarvis turn (sheet_save, 2026-10-04).
    const bad: string[] = [];
    for (const def of registry.allActions()) {
      if (!isVisibleTo(def, "agent") || !(def.input instanceof z.ZodObject)) continue;
      const schema = z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" });
      JSON.stringify(schema, (key, value) => {
        if (key === "pattern" && typeof value === "string" && !portablePattern(value))
          bad.push(`${def.name}: ${value}`);
        return value;
      });
    }
    expect(bad).toEqual([]);
  });

  it("has every connector that syncs on its own say when it stops, react to that, and add to the brief", () => {
    // A sync only the integration runs is one nobody watches: if it stops, the module has to
    // say so (an event), Jarvis has to tell you (a reflex), and the brief has to have its news.
    const checked: string[] = [];
    const missing: string[] = [];
    for (const m of registry.modules) {
      const sync = m.actions.find((a) => a.name === `${m.name}.sync`);
      if (!sync?.callers?.includes("integration")) continue;
      checked.push(m.name);
      const kind = `${m.name}.sync_failed`;
      if (!m.events.some((e) => e.kind === kind)) missing.push(`${m.name}: no ${kind} event`);
      if (!m.reflexes.some((r) => r.on.includes(kind)))
        missing.push(`${m.name}: nothing reacts to ${kind}`);
      if (!m.digest) missing.push(`${m.name}: nothing for the brief`);
    }
    expect(checked.sort()).toEqual(["calendar", "github", "mail", "notion", "slack"]);
    expect(missing).toEqual([]);
  });

  it("gives a pull request's changes their own events, so a watch can wait for a merge", () => {
    const github = registry.modules.find((m) => m.name === "github")!;
    expect(github.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["github.pr_opened", "github.pr_merged", "github.pr_closed"]),
    );
  });

  it("has Jarvis react to every kind of record a module owns", () => {
    // Each module either has reflexes or routines, or explains why not; none are silent.
    const silent = registry.modules.filter((m) => m.reflexes.length === 0 && !m.routines?.length);
    expect(silent.map((m) => [m.name, Boolean(m.noReflexesBecause)])).toEqual(
      silent.map((m) => [m.name, true]),
    );
  });
});
