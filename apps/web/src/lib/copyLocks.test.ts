// Which copies a screen takes in as it opens or hears a restore, and its first read (D59). Each
// screen holds a Web Lock named after its own copy while it's open, and keeps nothing before it's
// held, so another takes over only the copy of a screen that closed or crashed, as that screen left
// it: an open one saves its own, and a card it removes after the restore stays removed. Without Web
// Locks every other copy is taken over, so one a closed tab kept is still sent. A first read that
// fails is tried again once the browser is back online, one Hearth turns down says why, and nothing
// typed before it is taken, in meeting notes too. Runs against a fake Hearth, an in-memory
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

/** The Web Locks this browser holds, by name, in the order they were taken, each till let go. */
const held = new Map<string, Promise<unknown>>();
/** While set, a look at whether a lock is free waits for it first. */
let slow: Promise<void> | null = null;
type Granted = (lock: { name: string } | null) => Promise<unknown>;
type Request = [Granted] | [{ ifAvailable?: boolean }, Granted];
const locks = {
  async request(name: string, ...args: Request) {
    const fn = args.length === 2 ? args[1] : args[0];
    if (args.length === 2 && args[0].ifAvailable) {
      if (slow) await slow;
      if (held.has(name)) return fn(null);
    }
    while (held.has(name)) await held.get(name);
    const run = fn({ name }).finally(() => held.delete(name));
    held.set(name, Promise.allSettled([run]));
    return run;
  },
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
/** While set, Hearth's answers to reads wait for it. */
let late: Promise<void> | null = null;
/** The page is closing: a request without keepalive (over 64 KB, say) is dropped, then the tab. */
let closing = false;
const reply = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers();
  server = { version: 1, title: "Plan", data: { nodes: [card("a", "one")], edges: [] } };
  down = false;
  trashed = false;
  forbid = null;
  late = null;
  slow = null;
  closing = false;
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
    if (url.endsWith(".get") && late) await late;
    if (closing && !init.keepalive) return new Promise<Response>(() => {});
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
  /** Returns before the first read is done. */
  early?: boolean;
}) {
  const { createSaver } = await import("./wholeSave.ts");
  const { action } = await import("./api.ts");
  let shown = o.shown ?? o.empty();
  const saver = createSaver<T>({
    id: "r1",
    key: "x:r1",
    noun: o.noun ?? "board",
    action: "x.save",
    input: (data, baseVersion) => ({ id: "r1", data, baseVersion }),
    get: () => action<{ title: string; data: T; version: number }>("x.get"),
    merge: o.merge,
    empty: o.empty,
    current: () => structuredClone(shown),
    show: (data) => {
      shown = structuredClone(data);
    },
  });
  const loading = saver.load();
  if (!o.early) await loading;
  const edit = (fn: (d: T) => T) => {
    shown = fn(structuredClone(shown));
    saver.changed();
  };
  return { saver, edit, shown: () => shown, loading };
}
const board = () => open<Canvas>({ merge: mergeCanvas, empty: () => ({ nodes: [], edges: [] }) });
/** Meeting notes, set up as MeetingNotes.tsx sets them up, with the page's copy on screen. */
const notes = (shown = "", early = false) =>
  open<string>({ merge: mergeText, empty: () => "", noun: "meeting", shown, early });
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
    held.delete([...held.keys()][0]!);
    trashed = false;
    for (const fn of feed) fn(restore);
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.data)).toEqual(["one", "P card"]);
    expect(kept.size).toBe(0);
  });

  it("keeps what's too long to send as the page closes, and sends it at the next open", async () => {
    const p = await board();
    const long = "x".repeat(70_000);
    p.edit(add(card("p", long)));
    await vi.advanceTimersByTimeAsync(0);
    closing = true;
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    held.clear();
    closing = false;
    await board();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.data)).toEqual(["one", long]);
    expect(kept.size).toBe(0);
  });

  it("opens only once its own lock is held, so it keeps nothing another takes as closed", async () => {
    let grant = () => {};
    const granted = new Promise<void>((r) => {
      grant = r;
    });
    const request = async (name: string, ...args: Request) => {
      await granted;
      return locks.request(name, ...args);
    };
    vi.stubGlobal("navigator", { locks: { ...locks, request } });
    const b = await open<Canvas>({
      merge: mergeCanvas,
      empty: () => ({ nodes: [], edges: [] }),
      early: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    // Hearth's board is read, but the screen isn't open yet: a card put on it is ignored.
    expect(b.saver.loaded()).toBe(false);
    b.edit(add(card("e", "Early")));
    await vi.advanceTimersByTimeAsync(0);
    expect(kept.size).toBe(0);
    grant();
    await b.loading;
    expect(texts(b.shown())).toEqual(["one"]);
    b.edit(add(card("n", "Now")));
    await vi.advanceTimersByTimeAsync(0);
    expect([...kept.keys()]).toEqual([...held.keys()]);
  });

  it.each([
    ["lands", false],
    ["can't reach Hearth", true],
  ])(
    "takes a closed screen's copy as that screen left it (its last save %s)",
    async (_, offline) => {
      const p = await board();
      const q = await board();
      q.edit(add(card("t", "Q temp")));
      await vi.advanceTimersByTimeAsync(0);
      // P hears a restore and reads Q's copy, but is slow to look at Q's lock...
      let go = () => {};
      slow = new Promise<void>((r) => {
        go = r;
      });
      const [toP] = [...feed];
      toP!(restore);
      await vi.advanceTimersByTimeAsync(0);
      // ...and meanwhile Q removes the card and closes.
      q.edit(drop("t"));
      await vi.advanceTimersByTimeAsync(0);
      down = offline;
      await q.saver.close();
      down = false;
      slow = null;
      go();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(texts(server.data)).toEqual(["one"]);
      expect(texts(p.shown())).toEqual(["one"]);
      expect(kept.size).toBe(0);
    },
  );

  it("without Web Locks, takes over every other screen's copy as it hears a restore", async () => {
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
    // Q can't tell whether P is still open, so it saves P's copy too.
    expect(texts(server.data)).toEqual(["one", "P card", "Q card"]);
    expect(kept.size).toBe(0);
  });

  it("without Web Locks, sends at the next open what a tab closed offline kept", async () => {
    vi.stubGlobal("navigator", {});
    const p = await board();
    down = true;
    p.edit(add(card("p", "P card")));
    await vi.advanceTimersByTimeAsync(700);
    await p.saver.close();
    down = false;
    const q = await board();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.data)).toEqual(["one", "P card"]);
    expect(texts(q.shown())).toEqual(["one", "P card"]);
    expect(kept.size).toBe(0);
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

  it("says why when Hearth turns it down, and that it can't be changed until then", async () => {
    forbid = "Not yours.";
    const b = await board();
    expect(b.saver.problem()).toBe(
      "Hearth didn't open this board, so it can't be changed here: Not yours.",
    );
    // Meeting notes too: the box stays read-only, and this says why under it.
    const m = await notes();
    expect(m.saver.problem()).toBe(
      "Hearth didn't open this meeting, so it can't be changed here: Not yours.",
    );
  });

  // Typed onto the page's copy before it, a change has no base: merged by line onto none, an edited
  // line would stay beside the new one, and a deleted one would come back.
  it("is waited for by meeting notes: what's typed before it isn't taken", async () => {
    server.data = "Agenda\nOwner";
    let answer = () => {};
    late = new Promise<void>((r) => {
      answer = r;
    });
    const m = await notes("Agenda\nOwner", true);
    m.edit((t) => `${t}: Sam`);
    await vi.advanceTimersByTimeAsync(10);
    late = null;
    answer();
    await m.loading;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.data).toBe("Agenda\nOwner");
    expect(m.shown()).toBe("Agenda\nOwner");
    expect(kept.size).toBe(0);
  });

  it("is waited for by meeting notes while it can't reach Hearth, which they say", async () => {
    server.data = "Agenda\nOwner: TBD";
    down = true;
    const m = await notes("Agenda\nOwner: TBD");
    expect(m.saver.problem()).toBe(
      "Can't open this meeting right now: can't reach Hearth. Trying again…",
    );
    m.edit((t) => t.replace("TBD", "Sam"));
    await vi.advanceTimersByTimeAsync(5_000);
    down = false;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(server.data).toBe("Agenda\nOwner: TBD");
    expect(m.shown()).toBe("Agenda\nOwner: TBD");
    expect(kept.size).toBe(0);
  });
});
