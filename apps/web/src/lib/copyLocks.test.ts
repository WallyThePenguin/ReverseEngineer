// Which copies a screen takes in as it opens or hears a restore, and its first read (D59). Each
// screen holds a Web Lock named after its own copy while it's open, and keeps nothing before it's
// held, so another takes over only the copy of a screen that closed or crashed: an open one saves
// its own, and a card it removes after the restore stays removed. Without Web Locks none is taken
// over. A first read that fails is tried again once the browser is back online, one Hearth turns
// down says why, and meeting notes take typing before it. Runs against a fake Hearth, an in-memory
// stand-in for IndexedDB and fake Web Locks (no DOM here).
import { type Canvas, type CanvasNode, mergeCanvas, mergeText } from "@hearth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Unsaved } from "./docStore.ts";
import type { LiveEvent } from "./live.ts";

/** The unsaved copies this device keeps, by key. */
const kept = vi.hoisted(() => new Map<string, Unsaved<unknown>>());
vi.mock("./docStore.ts", () => ({
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
/** Who's listening to the live feed, in the order the screens opened; the tests send its events. */
const feed = vi.hoisted(() => new Set<(e: LiveEvent) => void>());
vi.mock("./live.ts", async (original) => ({
  ...(await original<typeof import("./live.ts")>()),
  onLiveEvent: (fn: (e: LiveEvent) => void) => {
    feed.add(fn);
    return () => feed.delete(fn);
  },
}));
const restore: LiveEvent = {
  seq: 1,
  kind: "entity.restored",
  entityId: "r1",
  actor: "o",
  payload: {},
};

/** The Web Locks this browser holds, by name, in the order they were taken. */
const held = new Set<string>();
const locks = {
  async request(name: string, fn: () => Promise<unknown>) {
    held.add(name);
    try {
      return await fn();
    } finally {
      held.delete(name);
    }
  },
  query: async () => ({ held: [...held].map((name) => ({ name })), pending: [] }),
};

const card = (id: string, text: string): CanvasNode =>
  ({ id, kind: "text", x: 0, y: 0, w: 100, h: 40, text }) as unknown as CanvasNode;
const texts = (b: unknown) =>
  (b as Canvas).nodes.map((n) => (n as unknown as { text: string }).text);

/** What Hearth has. */
let server: { version: number; title: string; data: unknown };
let down = false;
let trashed = false;
/** Hearth turns reads down, saying this. */
let forbid: string | null = null;
const reply = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers();
  server = { version: 1, title: "Plan", data: { nodes: [card("a", "one")], edges: [] } };
  down = false;
  trashed = false;
  forbid = null;
  feed.clear();
  kept.clear();
  held.clear();
  const win = Object.assign(new EventTarget(), {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: number) => clearTimeout(t),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { locks });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (down) throw new TypeError("Failed to fetch");
    if (trashed) return reply({ status: "error", code: "not_found", message: "No such" }, 404);
    const input = JSON.parse(String(init.body));
    if (url.endsWith(".get") && forbid)
      return reply({ status: "error", code: "forbidden", message: forbid }, 403);
    if (url.endsWith(".get")) return reply({ status: "ok", result: structuredClone(server) });
    if (input.baseVersion !== server.version)
      return reply({ status: "error", code: "conflict", message: "Changed since read." }, 409);
    server = { ...server, data: structuredClone(input.data), version: server.version + 1 };
    return reply({ status: "ok", result: { version: server.version } });
  });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A screen with the record open, saved through createSaver as the editors do. */
async function open<T>(o: {
  merge: (base: T, mine: T, theirs: T) => T;
  empty: () => T;
  noun?: string;
  /** What the page shows before the first read. */
  shown?: T;
  beforeRead?: boolean;
}) {
  const { createSaver } = await import("./wholeSave.ts");
  const { action } = await import("./api.ts");
  let shown = o.shown ?? o.empty();
  const saver = createSaver<T>({
    id: "r1",
    key: "x:r1",
    noun: o.noun ?? "board",
    action: "x.save",
    beforeRead: o.beforeRead,
    input: (data, baseVersion) => ({ id: "r1", data, baseVersion }),
    get: () => action<{ title: string; data: T; version: number }>("x.get"),
    merge: o.merge,
    empty: o.empty,
    current: () => structuredClone(shown),
    show: (data) => {
      shown = structuredClone(data);
    },
  });
  await saver.load();
  const edit = (fn: (d: T) => T) => {
    shown = fn(structuredClone(shown));
    saver.changed();
  };
  return { saver, edit, shown: () => shown };
}
const board = () => open<Canvas>({ merge: mergeCanvas, empty: () => ({ nodes: [], edges: [] }) });
const add =
  (...cards: CanvasNode[]) =>
  (b: Canvas) => ({ ...b, nodes: [...b.nodes, ...cards] });
const drop = (id: string) => (b: Canvas) => ({ ...b, nodes: b.nodes.filter((n) => n.id !== id) });

describe("copies kept by other screens", () => {
  it("leaves an open screen's copy to it, so a card it removes after the restore stays removed", async () => {
    const p = await board();
    const q = await board();
    const [toP, toQ] = [...feed];
    trashed = true;
    q.edit(add(card("t", "Q temp"), card("k", "Q keep")));
    await vi.advanceTimersByTimeAsync(700);
    expect(q.saver.gone()).toBe(true);
    // Restored while Q is offline: only P hears it, and Q's copy isn't P's to save.
    trashed = false;
    toP!(restore);
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(p.shown())).toEqual(["one"]);
    q.edit(drop("t"));
    await vi.advanceTimersByTimeAsync(700);
    // Back online, Q hears it and saves its own.
    toQ!(restore);
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.data)).toEqual(["one", "Q keep"]);
    expect(kept.size).toBe(0);
  });

  it("doesn't open offline from a copy another open screen keeps", async () => {
    const q = await board();
    down = true;
    q.edit(add(card("t", "Q temp")));
    await vi.advanceTimersByTimeAsync(700);
    const p = await board();
    expect(p.saver.loaded()).toBe(false);
    expect(texts(p.shown())).toEqual([]);
    q.edit(drop("t"));
    down = false;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(texts(server.data)).toEqual(["one"]);
    expect(texts(p.shown())).toEqual(["one"]);
    expect(kept.size).toBe(0);
  });

  it("takes over the copy of a screen that crashed, once the browser lets its lock go", async () => {
    const p = await board();
    await board();
    const [fromP] = [...feed];
    trashed = true;
    p.edit(add(card("p", "P card")));
    await vi.advanceTimersByTimeAsync(700);
    // P's tab crashes: it hears nothing more, and its lock goes with it.
    feed.delete(fromP!);
    held.delete([...held][0]!);
    trashed = false;
    for (const fn of feed) fn(restore);
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.data)).toEqual(["one", "P card"]);
    expect(kept.size).toBe(0);
  });

  it("keeps nothing before its own lock is held, so no other screen takes its copy as closed", async () => {
    let grant = () => {};
    const granted = new Promise<void>((r) => {
      grant = r;
    });
    const request = async (name: string, fn: () => Promise<unknown>) => {
      await granted;
      return locks.request(name, fn);
    };
    vi.stubGlobal("navigator", { locks: { ...locks, request } });
    const { createSaver } = await import("./wholeSave.ts");
    let shown = "Agenda";
    const saver = createSaver<string>({
      id: "r1",
      key: "x:r1",
      noun: "meeting",
      action: "x.save",
      beforeRead: true,
      input: (data, baseVersion) => ({ id: "r1", data, baseVersion }),
      get: () => new Promise(() => {}),
      merge: mergeText,
      empty: () => "",
      current: () => shown,
      show: (data) => {
        shown = data;
      },
    });
    shown = "Agenda\nTyped at once";
    saver.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(kept.size).toBe(0);
    grant();
    await vi.advanceTimersByTimeAsync(0);
    expect([...kept.keys()]).toEqual([...held]);
  });

  it("without Web Locks, takes over no other screen's copy: it stays kept here", async () => {
    vi.stubGlobal("navigator", {});
    const p = await board();
    const q = await board();
    trashed = true;
    p.edit(add(card("p", "P card")));
    q.edit(add(card("q", "Q card")));
    await vi.advanceTimersByTimeAsync(700);
    await p.saver.close();
    trashed = false;
    for (const fn of feed) fn(restore);
    await vi.advanceTimersByTimeAsync(0);
    // Q can't tell P closed, so it saves only its own.
    expect(texts(server.data)).toEqual(["one", "Q card"]);
    expect([...kept.values()].map((k) => texts(k.data))).toEqual([["one", "P card"]]);
  });
});

describe("the first read", () => {
  it("is tried again as soon as the browser is back online", async () => {
    down = true;
    const p = await board();
    expect(p.saver.problem()).toMatch(/can't reach Hearth/);
    down = false;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.saver.loaded()).toBe(true);
    expect(texts(p.shown())).toEqual(["one"]);
    expect(p.saver.problem()).toBeNull();
  });

  it("says why when Hearth turns it down, and that a board can't be changed until then", async () => {
    forbid = "Not yours.";
    const b = await board();
    expect(b.saver.problem()).toBe(
      "Hearth didn't open this board, so it can't be changed here: Not yours.",
    );
    // Meeting notes take typing meanwhile.
    const m = await open<string>({
      merge: mergeText,
      empty: () => "",
      noun: "meeting",
      beforeRead: true,
    });
    expect(m.saver.problem()).toBe("Hearth didn't open this meeting: Not yours.");
  });

  it("isn't waited for by meeting notes: typing before it is merged by line", async () => {
    server.data = "Agenda\nFrom Jarvis";
    down = true;
    // The page's copy, from before Jarvis wrote.
    const m = await open<string>({
      merge: mergeText,
      empty: () => "",
      noun: "meeting",
      shown: "Agenda",
      beforeRead: true,
    });
    m.edit((t) => `${t}\nTyped offline`);
    await vi.advanceTimersByTimeAsync(700);
    down = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.data).toBe("Agenda\nTyped offline\nFrom Jarvis");
    expect(m.shown()).toBe("Agenda\nTyped offline\nFrom Jarvis");
    expect(kept.size).toBe(0);
  });
});
