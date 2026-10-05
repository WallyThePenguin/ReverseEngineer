// A spreadsheet opened from the trash, or before Hearth answers (D59): until Hearth's copy has
// been read it takes no cell, sheet or name, since what's on screen is a blank workbook whose
// cells share their names with Hearth's, and a copy kept here earlier is what's saved once it's
// restored. Runs against a fake Hearth and an in-memory stand-in for IndexedDB (no DOM here).
import type { Workbook } from "@hearth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Unsaved } from "../lib/docStore.ts";
import type { LiveEvent } from "../lib/live.ts";

/** The unsaved copies this device keeps, by key. */
const kept = vi.hoisted(() => new Map<string, Unsaved<unknown>>());
vi.mock("../lib/docStore.ts", () => ({
  unsavedCopies: async (key: string) =>
    [...kept.values()]
      .filter((k) => k.key === key || k.key.startsWith(`${key}#`))
      .map((k) => structuredClone(k)),
  saveUnsaved: async (rec: Unsaved<unknown>) => void kept.set(rec.key, structuredClone(rec)),
  dropUnsaved: async (key: string) => void kept.delete(key),
  takeOverUnsaved: async (rec: Unsaved<unknown> | null, held: Unsaved<unknown>[]) => {
    for (const k of held)
      if (JSON.stringify(kept.get(k.key)) === JSON.stringify(k)) kept.delete(k.key);
    if (rec) kept.set(rec.key, structuredClone(rec));
  },
}));
/** Who's listening to the live feed; the tests send its events. */
const feed = vi.hoisted(() => new Set<(e: LiveEvent) => void>());
vi.mock("../lib/live.ts", async (original) => ({
  ...(await original<typeof import("../lib/live.ts")>()),
  onLiveEvent: (fn: (e: LiveEvent) => void) => {
    feed.add(fn);
    return () => feed.delete(fn);
  },
}));
// Results aren't checked here: the formula engine (WebAssembly) never loads.
vi.mock("./engine.ts", () => ({ engine: () => new Promise(() => {}) }));
const hear = (kind: string) => {
  for (const fn of feed) fn({ seq: 1, kind, entityId: "x1", actor: "owner", payload: {} });
};

/** What Hearth has: its first sheet has the id a new spreadsheet's first sheet gets. */
let server: { version: number; title: string; book: Workbook };
/** The spreadsheet is in the trash: Hearth says there's no such spreadsheet. */
let trashed = false;

const reply = (body: unknown, status = 200) => Response.json(body, { status });
const cells = (b: Workbook) => b.sheets[0]!.cells;

beforeEach(() => {
  vi.useFakeTimers();
  server = {
    version: 3,
    title: "Budget",
    book: {
      sheets: [{ id: "s1", name: "Costs", cells: { A1: "Revenue", B2: "100" }, widths: {} }],
    },
  };
  trashed = false;
  feed.clear();
  kept.clear();
  const win = Object.assign(new EventTarget(), {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: number) => clearTimeout(t),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (trashed)
      return reply({ status: "error", code: "not_found", message: "No such spreadsheet" }, 404);
    const input = JSON.parse(String(init.body));
    if (url.endsWith("sheet.get"))
      return reply({ status: "ok", result: { ...structuredClone(server), results: [] } });
    if (input.baseVersion !== server.version)
      return reply({ status: "error", code: "conflict", message: "Changed since read." }, 409);
    server = {
      title: input.title ?? server.title,
      book: structuredClone(input.book),
      version: server.version + 1,
    };
    return reply({ status: "ok", result: { version: server.version } });
  });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a spreadsheet before it's first read", () => {
  it("leaves Hearth's cell alone when one is typed before the first read", async () => {
    trashed = true;
    const { createSheet } = await import("./state.ts");
    const s = createSheet("x1");
    await s.load();
    expect(s.loaded()).toBe(false);
    // The pane's header says it's in the trash, with Restore: this doesn't say so again.
    expect(s.gone()).toBe(true);
    expect(s.problem()).toBe("There's nothing to show here until it's restored.");
    // The formula bar on the blank "Sheet1" the screen starts with, and the name box.
    s.set(0, { A1: "x" });
    s.rename("Renamed");
    await vi.advanceTimersByTimeAsync(700);
    expect(cells(s.book)).toEqual({});
    expect(kept.size).toBe(0);
    trashed = false;
    hear("entity.restored");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.problem()).toBeNull();
    expect(cells(server.book)).toEqual({ A1: "Revenue", B2: "100" });
    expect(server).toMatchObject({ version: 3, title: "Budget" });
    expect(cells(s.book)).toEqual({ A1: "Revenue", B2: "100" });
    expect(s.title()).toBe("Budget");
    expect(kept.size).toBe(0);
    // Read now, it takes them.
    s.set(0, { A1: "x" });
    await vi.advanceTimersByTimeAsync(700);
    expect(cells(server.book)).toEqual({ A1: "x", B2: "100" });
    await s.flush();
  });

  it("saves a copy kept here earlier, not a cell typed before the next first read", async () => {
    const { createSheet } = await import("./state.ts");
    const first = createSheet("x1");
    await first.load();
    // Moved to the trash elsewhere: a change made here then is kept, and the tab closes.
    trashed = true;
    first.set(0, { B2: "kept edit" });
    await vi.advanceTimersByTimeAsync(700);
    expect(first.problem()).toBe("Changes made here are kept, and saved once it's restored.");
    await first.flush();
    // Opened again while it's still in the trash, and typed in before it's read.
    const second = createSheet("x1");
    await second.load();
    second.set(0, { C3: "typed blind" });
    await vi.advanceTimersByTimeAsync(700);
    trashed = false;
    hear("entity.restored");
    await vi.advanceTimersByTimeAsync(0);
    expect(cells(server.book)).toEqual({ A1: "Revenue", B2: "kept edit" });
    expect(cells(second.book)).toEqual({ A1: "Revenue", B2: "kept edit" });
    expect(kept.size).toBe(0);
    await second.flush();
  });
});
