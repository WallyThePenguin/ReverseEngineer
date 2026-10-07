// Saving a board whole (D59): a save that lost a race is merged card by card and sent again, a
// save that can't reach Hearth keeps trying, Hearth's own reason shows when it refuses one, a
// closing page still sends what's unsaved, and a board restored from the trash saves what was
// changed while it was there, however the restore and Hearth's answers cross, on this screen and
// on one closed meanwhile. A board takes nothing before the first read, a copy kept with no base
// (by an older Hearth) deletes nothing of Hearth's board, and one is opened and saved on a page
// served over plain http too. Runs against a fake Hearth, an in-memory stand-in for IndexedDB and
// fake Web Locks (no DOM here).
import type { Canvas, CanvasNode } from "@hearth/core";
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

/** Who's listening to the live feed; the tests send its events. */
const feed = vi.hoisted(() => new Set<(e: LiveEvent) => void>());
vi.mock("./live.ts", async (original) => ({
  ...(await original<typeof import("./live.ts")>()),
  onLiveEvent: (fn: (e: LiveEvent) => void) => {
    feed.add(fn);
    return () => feed.delete(fn);
  },
}));
const hear = (kind: string) => {
  for (const fn of feed) fn({ seq: 1, kind, entityId: "b1", actor: "owner", payload: {} });
};
/** The Web Locks this browser holds: a screen's copy is taken over only once its lock goes. */
const locked = new Set<string>();
type Granted = (lock: { name: string } | null) => Promise<unknown>;
const locks = {
  async request(name: string, ...args: [Granted] | [{ ifAvailable?: boolean }, Granted]) {
    const fn = args.length === 2 ? args[1] : args[0];
    if (args.length === 2 && args[0].ifAvailable && locked.has(name)) return fn(null);
    locked.add(name);
    try {
      return await fn({ name });
    } finally {
      locked.delete(name);
    }
  },
};

const card = (id: string, text: string): CanvasNode =>
  ({ id, kind: "text", x: 0, y: 0, w: 100, h: 40, text }) as unknown as CanvasNode;

/** What Hearth has, and every save sent to it. */
let server: { version: number; title: string; board: Canvas };
let down = false;
let refuse: string | null = null;
/** Hearth fails at saves (a bug, or its database deadlocked). */
let failing = false;
/** The board is in the trash: Hearth says there's no such board. */
let trashed = false;
/** While set, Hearth's answers wait for it: each is decided as its request arrives. */
let late: Promise<void> | null = null;
let held = 0;
let sent: { input: { baseVersion: number; board: Canvas }; keepalive: boolean }[] = [];

const reply = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers();
  server = { version: 1, title: "Plan", board: { nodes: [card("a", "one")], edges: [] } };
  down = false;
  refuse = null;
  failing = false;
  trashed = false;
  late = null;
  held = 0;
  feed.clear();
  kept.clear();
  locked.clear();
  sent = [];
  const win = Object.assign(new EventTarget(), {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: number) => clearTimeout(t),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { locks });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const inTrash = trashed;
    if (late) {
      held++;
      await late;
    }
    if (down) throw new TypeError("Failed to fetch");
    if (inTrash)
      return reply({ status: "error", code: "not_found", message: "No such canvas" }, 404);
    const input = JSON.parse(String(init.body));
    if (url.endsWith("canvas.get"))
      return reply({ status: "ok", result: { ...structuredClone(server), board: server.board } });
    sent.push({ input, keepalive: init.keepalive === true });
    if (refuse) return reply({ status: "error", code: "invalid_input", message: refuse }, 400);
    if (failing)
      return reply({ status: "error", code: "failed", message: "deadlock detected (40P01)" }, 400);
    if (input.baseVersion !== server.version)
      return reply({ status: "error", code: "conflict", message: "Changed since read." }, 409);
    server = { ...server, board: structuredClone(input.board), version: server.version + 1 };
    return reply({ status: "ok", result: { version: server.version } });
  });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A board on screen, saved through createSaver as the canvas editor does. */
async function openBoard() {
  const { createSaver } = await import("./wholeSave.ts");
  const { action } = await import("./api.ts");
  const { mergeCanvas } = await import("@hearth/core");
  let shown: Canvas = { nodes: [], edges: [] };
  const saver = createSaver<Canvas>({
    id: "b1",
    key: "canvas:b1",
    noun: "board",
    action: "canvas.save",
    input: (board, baseVersion) => ({ id: "b1", board, baseVersion }),
    async get() {
      const r = await action<{ title: string; board: Canvas; version: number }>("canvas.get");
      return { title: r.title, data: r.board, version: r.version };
    },
    merge: mergeCanvas,
    empty: () => ({ nodes: [], edges: [] }),
    current: () => structuredClone(shown),
    show: (data) => {
      shown = structuredClone(data);
    },
  });
  await saver.load();
  const edit = (fn: (b: Canvas) => void) => {
    fn(shown);
    saver.changed();
  };
  return { saver, edit, shown: () => shown };
}
const texts = (b: Canvas) => b.nodes.map((n) => (n as unknown as { text: string }).text);

describe("saving a board whole", () => {
  it("merges a save that lost a race card by card, instead of overwriting the winner", async () => {
    const { saver, edit, shown } = await openBoard();
    edit((b) => {
      (b.nodes[0] as unknown as { text: string }).text = "one, edited";
    });
    // Jarvis adds a card before the edit is saved.
    server = {
      ...server,
      version: 2,
      board: { nodes: [...server.board.nodes, card("j", "from Jarvis")], edges: [] },
    };
    await vi.advanceTimersByTimeAsync(700);
    expect(sent.map((s) => s.input.baseVersion)).toEqual([1, 2]);
    expect(texts(server.board)).toEqual(["one, edited", "from Jarvis"]);
    expect(texts(shown())).toEqual(["one, edited", "from Jarvis"]);
    expect(server.version).toBe(3);
    expect(saver.problem()).toBeNull();
  });

  it("keeps trying while Hearth is out of reach, and says so", async () => {
    const { saver, edit } = await openBoard();
    down = true;
    edit((b) => b.nodes.push(card("b", "two")));
    await vi.advanceTimersByTimeAsync(700);
    expect(saver.problem()).toMatch(/can't reach Hearth/);
    down = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts(server.board)).toEqual(["one", "two"]);
    expect(saver.problem()).toBeNull();
  });

  it("reads a newer version it couldn't read again soon, rather than at the next one", async () => {
    const { saver, shown } = await openBoard();
    // Jarvis saved it, and reading that doesn't reach Hearth.
    server = { ...server, version: 2, board: { nodes: [card("j", "from Jarvis")], edges: [] } };
    down = true;
    await saver.load();
    down = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts(shown())).toEqual(["from Jarvis"]);
  });

  it("says Hearth hit a problem, not that it's out of reach, when it fails a save", async () => {
    const { saver, edit } = await openBoard();
    failing = true;
    edit((b) => b.nodes.push(card("b", "two")));
    await vi.advanceTimersByTimeAsync(700);
    // Hearth's own text for a failure is its internals: not shown.
    expect(saver.problem()).toBe("Not saved yet: Hearth hit a problem saving it. Trying again…");
    failing = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts(server.board)).toEqual(["one", "two"]);
    expect(saver.problem()).toBeNull();
  });

  it("shows Hearth's own reason when it turns a save down", async () => {
    const { saver, edit } = await openBoard();
    refuse = "A card can hold up to 10,000 characters.";
    edit((b) => b.nodes.push(card("b", "x")));
    await vi.advanceTimersByTimeAsync(700);
    expect(saver.problem()).toBe(
      "Hearth didn't save this: A card can hold up to 10,000 characters.",
    );
    // Not tried again by itself: it would only be turned down again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
  });

  it("opens and saves on a page served over plain http, which has no crypto.randomUUID", async () => {
    // Nor Web Locks: both need https (or localhost).
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    vi.stubGlobal("navigator", {});
    const { saver, edit, shown } = await openBoard();
    expect(texts(shown())).toEqual(["one"]);
    edit((b) => b.nodes.push(card("b", "two")));
    await vi.advanceTimersByTimeAsync(700);
    expect(texts(server.board)).toEqual(["one", "two"]);
    expect(saver.problem()).toBeNull();
  });

  it("sends what's unsaved as the page closes, without waiting for the pause", async () => {
    const { edit } = await openBoard();
    edit((b) => b.nodes.push(card("b", "typed just before closing")));
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.keepalive).toBe(true);
    expect(texts(server.board)).toEqual(["one", "typed just before closing"]);
  });

  it("saves what was changed while the board was in the trash once it's restored", async () => {
    const { saver, edit } = await openBoard();
    trashed = true;
    edit((b) => b.nodes.push(card("b", "two")));
    await vi.advanceTimersByTimeAsync(700);
    expect(saver.problem()).toMatch(/deleted/);
    edit((b) => b.nodes.push(card("c", "three")));
    await vi.advanceTimersByTimeAsync(700);
    trashed = false;
    hear("entity.restored");
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.board)).toEqual(["one", "two", "three"]);
    expect(saver.problem()).toBeNull();
  });

  it("opens a board that was in the trash when it opened, once it's restored", async () => {
    trashed = true;
    const { saver, shown } = await openBoard();
    // Nothing has been on screen to change, so it doesn't speak of saving changes.
    expect(saver.problem()).toBe("This board is in the trash. Restore it to open it here.");
    trashed = false;
    hear("entity.restored");
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(shown())).toEqual(["one"]);
    expect(saver.problem()).toBeNull();
  });

  it("saves a change Hearth said was in the trash when the restore was heard first", async () => {
    const { saver, edit } = await openBoard();
    trashed = true;
    let answer!: () => void;
    late = new Promise((r) => (answer = r));
    edit((b) => b.nodes.push(card("b", "two")));
    // The save goes out once the pretend clock passes the pause after an edit, and is held. The
    // clock is moved here, not by vi.waitFor: that moves it 50 ms per real 50 ms and gives up
    // after a real second, and getting through the pause took 0.8 s idle, over 1 on a busy runner.
    await vi.advanceTimersByTimeAsync(700);
    expect(held).toBe(1);
    trashed = false;
    late = null;
    hear("entity.restored");
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.board)).toEqual(["one", "two"]);
    expect(saver.problem()).toBeNull();
  });

  it("opens a board Hearth said was in the trash when the restore was heard first", async () => {
    trashed = true;
    let answer!: () => void;
    late = new Promise((r) => (answer = r));
    const opening = openBoard();
    // Its first read is held as it arrives, once the modules have loaded: that takes real time,
    // so it gets a deadline far beyond it.
    await vi.waitFor(() => expect(held).toBe(1), { timeout: 10_000 });
    trashed = false;
    late = null;
    hear("entity.restored");
    answer();
    const { saver, shown } = await opening;
    expect(texts(shown())).toEqual(["one"]);
    expect(saver.problem()).toBeNull();
  });

  it("takes no change before it's first read, so a copy kept here earlier survives", async () => {
    // Kept here before (an older Hearth kept one copy per board, under its bare key).
    kept.set("canvas:b1", {
      key: "canvas:b1",
      data: { nodes: [card("a", "one"), card("k", "Kept")], edges: [] },
      base: structuredClone(server.board),
      baseVersion: 1,
    });
    trashed = true;
    // Opened from the trash: nothing's been read, and a card goes on the empty screen.
    const { saver, edit } = await openBoard();
    edit((b) => b.nodes.push(card("n", "Blind")));
    saver.rename("Blind name");
    await vi.advanceTimersByTimeAsync(700);
    trashed = false;
    hear("entity.restored");
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.board)).toEqual(["one", "Kept"]);
    expect(sent.some((s) => "title" in s.input)).toBe(false);
    expect(saver.problem()).toBeNull();
    expect(kept.size).toBe(0);
  });

  it("saves what each screen changed while it was in the trash, though one closed first", async () => {
    const p = await openBoard();
    const q = await openBoard();
    trashed = true;
    p.edit((b) => b.nodes.push(card("p", "P card"), card("t", "P temp")));
    await vi.advanceTimersByTimeAsync(700);
    q.edit((b) => b.nodes.push(card("q", "Q card")));
    // Its own later copy replaces its earlier one: a card it removed doesn't come back.
    p.edit((b) => {
      b.nodes = b.nodes.filter((n) => n.id !== "t");
    });
    await vi.advanceTimersByTimeAsync(700);
    await p.saver.close();
    trashed = false;
    hear("entity.restored");
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.board)).toEqual(["one", "P card", "Q card"]);
    expect(texts(q.shown())).toEqual(["one", "P card", "Q card"]);
    expect(q.saver.problem()).toBeNull();
    expect(kept.size).toBe(0);
  });

  it("saves what every closed screen kept at the next open", async () => {
    const p = await openBoard();
    const q = await openBoard();
    trashed = true;
    p.edit((b) => b.nodes.push(card("p", "P card")));
    q.edit((b) => {
      b.nodes[0] = card("a", "one, edited");
    });
    await vi.advanceTimersByTimeAsync(700);
    await Promise.all([p.saver.close(), q.saver.close()]);
    expect(kept.size).toBe(2);
    // Restored with neither open: the next open takes in both.
    trashed = false;
    const { shown } = await openBoard();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(server.board)).toEqual(["one, edited", "P card"]);
    expect(texts(shown())).toEqual(["one, edited", "P card"]);
    expect(kept.size).toBe(0);
  });

  it.each([0, 1])(
    "merges a copy kept with no base onto Hearth's, deleting nothing (made on version %i)",
    async (baseVersion) => {
      server.board = { nodes: [card("a", "Original")], edges: [] };
      kept.set("canvas:b1", {
        key: "canvas:b1",
        data: { nodes: [card("n", "Added")], edges: [] },
        base: null,
        baseVersion,
      });
      const { shown } = await openBoard();
      await vi.advanceTimersByTimeAsync(0);
      expect(texts(shown())).toEqual(["Original", "Added"]);
      expect(texts(server.board)).toEqual(["Original", "Added"]);
      expect(kept.size).toBe(0);
    },
  );
});
