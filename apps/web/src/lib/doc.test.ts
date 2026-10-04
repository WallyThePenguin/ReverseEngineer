// A note's edits are written ahead (D59): one made just before its tab dies is sent by the next
// open, as the same peer, without clashing; edits are dropped from disk only once a saved copy
// holds them, and one tab's saved copy never loses another's; a deleted note keeps what Hearth
// never got. Runs against a fake Hearth and an in-memory stand-in for IndexedDB.
import { LoroDoc, VersionVector } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingKey, PendingUpdate, SavedDoc } from "./docStore.ts";

const disk = vi.hoisted(() => ({
  docs: new Map<string, SavedDoc>(),
  updates: new Map<string, PendingUpdate>(),
  /** Every claim of a peer hands out this one, as a device's first slot would. */
  peer: 1001n,
  /** Writing ahead fails, as it does where IndexedDB can't be opened. */
  full: false,
}));

vi.mock("./docStore.ts", () => ({
  loadDoc: async (id: string) => disk.docs.get(id) ?? null,
  pendingUpdates: async (doc: string) => [...disk.updates.values()].filter((u) => u.doc === doc),
  appendUpdate: async (u: PendingUpdate) => {
    if (disk.full) return false;
    disk.updates.set([u.doc, u.tab, u.n].join("|"), u);
    return true;
  },
  keepDoc: async (
    id: string,
    next: (s: SavedDoc | null) => SavedDoc | null,
    drop: PendingKey[],
  ) => {
    const rec = next(disk.docs.get(id) ?? null);
    if (rec) disk.docs.set(id, structuredClone(rec));
    else disk.docs.delete(id);
    for (const k of drop) disk.updates.delete(k.join("|"));
    return true;
  },
}));
vi.mock("./peer.ts", () => ({
  claimPeer: async () => ({ peer: disk.peer, release() {}, retire() {} }),
}));

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Hearth's copy of the note, and how it answers. */
let hearth: LoroDoc;
let mode: "up" | "down" | "hang" | "gone" | "refuse" | "fail" = "up";
let syncs = 0;
const reply = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  disk.docs.clear();
  disk.updates.clear();
  disk.peer = 1001n;
  disk.full = false;
  hearth = new LoroDoc();
  hearth.getText("body").insert(0, "Plan");
  hearth.commit();
  mode = "up";
  syncs = 0;
  const win = Object.assign(new EventTarget(), {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: number) => clearTimeout(t),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (t: number) => clearInterval(t),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    if (mode === "down") throw new TypeError("Failed to fetch");
    if (mode === "hang") return new Promise(() => {});
    if (mode === "gone")
      return reply({ status: "error", code: "not_found", message: "No such doc" });
    if (mode === "fail")
      return reply({ status: "error", code: "failed", message: "deadlock detected (40P01)" });
    if (mode === "refuse")
      return reply({ status: "error", code: "invalid_input", message: "That's too long to save." });
    syncs++;
    const i = JSON.parse(String(init.body)) as { update?: string; version?: string };
    if (i.update) hearth.import(unb64(i.update));
    const from = i.version ? VersionVector.decode(unb64(i.version)) : undefined;
    return reply({
      status: "ok",
      result: {
        update: b64(hearth.export(from ? { mode: "update", from } : { mode: "snapshot" })),
        version: b64(hearth.oplogVersion().encode()),
      },
    });
  });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open() {
  const { LiveDoc } = await import("./doc.ts");
  const doc = new LiveDoc("n1");
  const seen: string[] = [];
  doc.onStatus = (s) => seen.push(s.kind);
  await doc.open();
  await vi.advanceTimersByTimeAsync(0);
  const type = (s: string) => {
    const text = doc.doc.getText("body");
    text.insert(text.length, s);
    doc.doc.commit();
  };
  return { doc, type, seen };
}
const hearthText = () => hearth.getText("body").toString();
const savedText = () => {
  const d = new LoroDoc();
  d.import(disk.docs.get("n1")!.snapshot);
  return d.getText("body").toString();
};

describe("a note's edits, written ahead", () => {
  it("sends an edit made just before its tab died, and goes on as the same peer", async () => {
    const a = await open();
    mode = "hang";
    a.type(" for Monday");
    // Written to disk at once; the sync that would send it never answers, then the tab dies.
    await vi.advanceTimersByTimeAsync(600);
    expect(disk.updates.size).toBe(1);
    vi.clearAllTimers();
    mode = "up";
    const b = await open();
    expect(b.doc.text).toBe("Plan for Monday");
    expect(hearthText()).toBe("Plan for Monday");
    b.type(", then Tuesday");
    await vi.advanceTimersByTimeAsync(600);
    // The same peer carried on from where the dead tab's edit left off: Hearth took both.
    expect(hearthText()).toBe("Plan for Monday, then Tuesday");
    expect(hearth.oplogVersion().toJSON().get("1001")).toBe(" for Monday, then Tuesday".length);
    await b.doc.close();
  });

  it("drops edits from disk only once a saved copy holds them", async () => {
    const a = await open();
    mode = "down";
    a.type("!");
    await vi.advanceTimersByTimeAsync(600);
    expect(a.seen.at(-1)).toBe("offline");
    expect(disk.updates.size).toBe(1);
    await a.doc.close();
    // Folded into the saved copy, which says it holds edits Hearth hasn't got.
    expect(disk.updates.size).toBe(0);
    expect(savedText()).toBe("Plan!");
    expect(disk.docs.get("n1")!.unsent).toBe(1);
    mode = "up";
    const b = await open();
    expect(hearthText()).toBe("Plan!");
    await b.doc.close();
    expect(disk.docs.get("n1")!.unsent).toBeUndefined();
  });

  it("never saves over another tab's copy with an older one", async () => {
    const a = await open();
    disk.peer = 2002n;
    const b = await open();
    mode = "down";
    a.type(" A");
    b.type(" B");
    await vi.advanceTimersByTimeAsync(600);
    await a.doc.close();
    await b.doc.close();
    expect(savedText()).toMatch(/^Plan( A B| B A)$/);
    mode = "up";
    disk.peer = 1001n;
    const c = await open();
    expect(hearthText()).toBe(c.doc.text);
    expect(hearthText()).toMatch(/^Plan( A B| B A)$/);
    await c.doc.close();
  });

  it("syncs at least every 2 seconds while you keep typing", async () => {
    const a = await open();
    const before = syncs;
    for (let n = 0; n < 8; n++) {
      a.type(`${n}`);
      await vi.advanceTimersByTimeAsync(300);
    }
    // 2.4 seconds without a pause: a 500 ms pause alone would never have synced.
    expect(syncs).toBeGreaterThan(before);
    await a.doc.close();
  });

  it("asks before the page closes only when an unsent edit isn't kept on this device", async () => {
    /** Whether closing the page now would ask first. */
    const asks = () => {
      const e = new Event("beforeunload", { cancelable: true });
      Object.defineProperty(e, "returnValue", { writable: true, value: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const a = await open();
    mode = "down";
    a.type(" kept");
    await vi.advanceTimersByTimeAsync(600);
    // Unsent, but on disk: the next open sends it, so closing doesn't ask.
    expect(asks()).toBe(false);
    disk.full = true;
    a.type(" here only");
    await vi.advanceTimersByTimeAsync(600);
    expect(asks()).toBe(true);
    mode = "up";
    a.doc.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    // Hearth has it now.
    expect(hearthText()).toBe("Plan kept here only");
    expect(asks()).toBe(false);
    await a.doc.close();
  });

  it("says why when Hearth turns edits down", async () => {
    const a = await open();
    mode = "refuse";
    a.type("x");
    await vi.advanceTimersByTimeAsync(600);
    expect(a.seen.at(-1)).toBe("refused");
    await a.doc.close();
  });

  it("doesn't call Hearth out of reach when it failed at a sync, and tries again", async () => {
    const a = await open();
    mode = "fail";
    a.type(" again");
    await vi.advanceTimersByTimeAsync(600);
    expect(a.seen.at(-1)).toBe("retrying");
    mode = "up";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hearthText()).toBe("Plan again");
    expect(a.seen.at(-1)).toBe("ok");
    await a.doc.close();
  });

  it("keeps what a deleted note never sent, and forgets one with nothing unsent", async () => {
    const a = await open();
    mode = "gone";
    a.type(" (draft)");
    await vi.advanceTimersByTimeAsync(600);
    expect(a.seen.at(-1)).toBe("gone");
    expect(savedText()).toBe("Plan (draft)");
    expect(disk.updates.size).toBe(0);
    await a.doc.close();

    disk.docs.clear();
    mode = "up";
    const b = await open();
    mode = "gone";
    b.doc.schedule(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.seen.at(-1)).toBe("gone");
    expect(disk.docs.has("n1")).toBe(false);
    await b.doc.close();
  });
});
