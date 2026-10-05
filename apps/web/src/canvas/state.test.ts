// A board opened from the trash (D59): until Hearth's copy has been read it takes no cards and no
// new name, since there's nothing on screen to change, and once it's restored it opens whole.
// Runs against a fake Hearth and an in-memory stand-in for IndexedDB (no DOM here).
import type { Canvas, CanvasNode } from "@hearth/core";
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
const hear = (kind: string) => {
  for (const fn of feed) fn({ seq: 1, kind, entityId: "b1", actor: "owner", payload: {} });
};

const card = (id: string, text: string): CanvasNode =>
  ({ id, type: "text", x: 0, y: 0, width: 100, height: 40, text }) as CanvasNode;
const texts = (b: Canvas) => b.nodes.map((n) => (n as { text: string }).text);

/** What Hearth has. */
let server: { version: number; title: string; board: Canvas };
/** The board is in the trash: Hearth says there's no such board. */
let trashed = false;

const reply = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers();
  server = { version: 1, title: "Plan", board: { nodes: [card("a", "Original")], edges: [] } };
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
      return reply({ status: "error", code: "not_found", message: "No such canvas" }, 404);
    const input = JSON.parse(String(init.body));
    if (url.endsWith("canvas.get"))
      return reply({ status: "ok", result: { ...structuredClone(server), board: server.board } });
    if (input.baseVersion !== server.version)
      return reply({ status: "error", code: "conflict", message: "Changed since read." }, 409);
    server = {
      title: input.title ?? server.title,
      board: structuredClone(input.board),
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

describe("a board opened from the trash", () => {
  it("takes no changes until it's first read, and opens whole once restored", async () => {
    trashed = true;
    const { createBoard } = await import("./state.ts");
    const b = createBoard("b1");
    await b.load();
    expect(b.loaded()).toBe(false);
    expect(b.problem()).toBe("There's nothing to show here until it's restored.");
    b.add(card("n", "Added"));
    b.rename("Renamed");
    await vi.advanceTimersByTimeAsync(700);
    expect(b.board.nodes).toEqual([]);
    expect(kept.size).toBe(0);
    trashed = false;
    hear("entity.restored");
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(b.board)).toEqual(["Original"]);
    expect(b.title()).toBe("Plan");
    expect(b.problem()).toBeNull();
    expect(server).toMatchObject({ version: 1, title: "Plan" });
    expect(texts(server.board)).toEqual(["Original"]);
    // Read now, it takes changes.
    b.add(card("n", "Added"));
    await vi.advanceTimersByTimeAsync(700);
    expect(texts(server.board)).toEqual(["Original", "Added"]);
    await b.flush();
  });
});
