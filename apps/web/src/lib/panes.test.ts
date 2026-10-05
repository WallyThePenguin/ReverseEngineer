// Split panes keep their keys: closing a pane to the left, or opening one beside, never hands a
// pane's focus, hotkeys or close button to another. Runs against a fake browser (no DOM here).
import { beforeEach, describe, expect, it, vi } from "vitest";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

let path = "/";
const popHandlers: (() => void)[] = [];

beforeEach(() => {
  vi.resetModules();
  path = "/";
  popHandlers.length = 0;
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    addEventListener: (kind: string, fn: () => void) => kind === "popstate" && popHandlers.push(fn),
  });
  vi.stubGlobal("location", {
    get pathname() {
      return path;
    },
  });
  vi.stubGlobal("history", {
    pushState: (_s: unknown, _t: string, url: string) => {
      path = url;
    },
    replaceState: (_s: unknown, _t: string, url: string) => {
      path = url;
    },
  });
});

async function layoutAt(start: string) {
  path = start;
  const { createPanes } = await import("./panes.ts");
  const { createRoot } = await import("solid-js");
  return createRoot(() => createPanes());
}

describe("panes", () => {
  it("keeps each pane's key when a pane to its left closes", async () => {
    const layout = await layoutAt("/inbox+tasks");
    const [inbox, tasks] = layout.entries();
    layout.focus(1);
    layout.close(0);
    expect(layout.entries()).toEqual([tasks]);
    expect(layout.indexOf(tasks!.key)).toBe(0);
    expect(layout.indexOf(inbox!.key)).toBe(-1);
    // The pane you were in keeps focus, at its new place.
    expect(layout.focused()).toBe(0);
    expect(path).toBe("/tasks");
  });

  it("keeps focus on the pane you're in when another one closes", async () => {
    const layout = await layoutAt("/inbox+tasks+notes");
    const notes = layout.entries()[2]!;
    layout.focus(2);
    layout.close(0);
    expect(layout.focused()).toBe(layout.indexOf(notes.key));
    expect(layout.focused()).toBe(1);
  });

  it("moves focus to a neighbour when the focused pane closes", async () => {
    const layout = await layoutAt("/inbox+tasks+notes");
    layout.focus(1);
    layout.close();
    expect(layout.panes().map((r) => r.view)).toEqual(["inbox", "notes"]);
    expect(layout.focused()).toBe(1);
  });

  it("opens beside without changing the keys of the panes already open", async () => {
    const layout = await layoutAt("/inbox+notes");
    const before = layout.entries();
    layout.focus(0);
    layout.open({ view: "tasks" }, { beside: true });
    expect(layout.panes().map((r) => r.view)).toEqual(["inbox", "tasks", "notes"]);
    expect(layout.entries()[0]).toBe(before[0]);
    expect(layout.entries()[2]).toBe(before[1]);
    expect(layout.focused()).toBe(1);
  });

  it("shows a record beside its list and keeps focus on the list", async () => {
    const layout = await layoutAt("/tasks");
    const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    layout.show({ view: "task", id }, 0);
    expect(layout.panes()).toEqual([{ view: "tasks" }, { view: "task", id }]);
    expect(layout.focused()).toBe(0);
    // Showing the same record again leaves its pane as it is.
    const shown = layout.entries()[1];
    layout.show({ view: "task", id }, 0);
    expect(layout.entries()[1]).toBe(shown);
  });

  it("keeps the panes that didn't change on back and forward", async () => {
    const layout = await layoutAt("/inbox+tasks");
    const [inbox, tasks] = layout.entries();
    layout.open({ view: "notes" }, { beside: true, pane: 1 });
    path = "/inbox+tasks";
    for (const fn of popHandlers) fn();
    expect(layout.entries()).toEqual([inbox, tasks]);
    expect(layout.entries()[0]).toBe(inbox);
  });
});
