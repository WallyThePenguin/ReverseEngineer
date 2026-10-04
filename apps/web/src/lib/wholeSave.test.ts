// Saving a board whole (D59): a save that lost a race is merged card by card and sent again, a
// save that can't reach Hearth keeps trying, Hearth's own reason shows when it refuses one, a
// closing page still sends what's unsaved, and a board restored from the trash saves what was
// changed while it was there. Runs against a fake Hearth (no DOM or IndexedDB here).
import type { Canvas, CanvasNode } from "@hearth/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "./live.ts";

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
let sent: { input: { baseVersion: number; board: Canvas }; keepalive: boolean }[] = [];

const reply = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers();
  server = { version: 1, title: "Plan", board: { nodes: [card("a", "one")], edges: [] } };
  down = false;
  refuse = null;
  failing = false;
  trashed = false;
  feed.clear();
  sent = [];
  const win = Object.assign(new EventTarget(), {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: number) => clearTimeout(t),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (down) throw new TypeError("Failed to fetch");
    if (trashed)
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
    expect(saver.problem()).toMatch(/deleted/);
    trashed = false;
    hear("entity.restored");
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(shown())).toEqual(["one"]);
    expect(saver.problem()).toBeNull();
  });
});
