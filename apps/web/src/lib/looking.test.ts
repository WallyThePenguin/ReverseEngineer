// What goes with what you ask Jarvis (step 10): the record in the pane you were last in, never a
// list or the conversation itself, and not once you've taken it off, until you open another.
// Runs against a fake browser (no DOM here), as panes.test.ts does.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

// Records are named by UUID in an address.
const T1 = "00000000-0000-4000-8000-0000000000a1";
const N1 = "00000000-0000-4000-8000-0000000000b1";

let path = "/";
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    addEventListener: () => {},
  });
  vi.stubGlobal("location", {
    get pathname() {
      return path;
    },
  });
  const go = (_s: unknown, _t: string, url: string) => {
    path = url;
  };
  vi.stubGlobal("history", { pushState: go, replaceState: go });
});

async function at(start: string) {
  path = start;
  const { createPanes } = await import("./panes.ts");
  const { createRoot } = await import("solid-js");
  const { useLooking } = await import("./looking.ts");
  return createRoot(() => {
    const panes = createPanes();
    return { panes, ...useLooking(panes) };
  });
}

describe("what's on screen as you ask", () => {
  it("is the record in the pane you were last in", async () => {
    const { lookingAt } = await import("./looking.ts");
    expect(lookingAt({ view: "task", id: "t1" })).toEqual({ id: "t1", view: "task" });
    expect(lookingAt({ view: "thread", id: "m1" })).toEqual({ id: "m1", view: "thread" });
    expect(lookingAt({ view: "record", id: "p1" })).toEqual({ id: "p1", view: "record" });
    // A screen with no record open, or the conversation you're talking in, sends nothing.
    expect(lookingAt({ view: "today" })).toBeNull();
    expect(lookingAt({ view: "tasks" })).toBeNull();
    expect(lookingAt({ view: "chat", id: "c1" })).toBeNull();
    expect(lookingAt(undefined)).toBeNull();
  });

  it("follows the pane you're in", async () => {
    const s = await at(`/today+task/${T1}`);
    expect(s.looking()).toBeNull();
    s.panes.focus(1);
    expect(s.looking()).toEqual({ id: T1, view: "task" });
    s.panes.open({ view: "note", id: N1 });
    expect(s.looking()).toEqual({ id: N1, view: "note" });
  });

  it("stays off once taken off, until you open something else", async () => {
    const s = await at(`/task/${T1}`);
    s.takeOff();
    expect(s.looking()).toBeNull();
    s.panes.open({ view: "note", id: N1 });
    expect(s.looking()).toEqual({ id: N1, view: "note" });
  });

  it("offers asks that fit the kind of record, and the usual ones otherwise", async () => {
    const { startersFor } = await import("./looking.ts");
    expect(startersFor("email_thread")).toContain("Draft a reply to this");
    expect(startersFor("task")).toContain("Do this for me");
    expect(startersFor("meeting")).toContain("Prep me for this");
    expect(startersFor("canvas")).toBeNull();
    expect(startersFor(undefined)).toBeNull();
  });
});
