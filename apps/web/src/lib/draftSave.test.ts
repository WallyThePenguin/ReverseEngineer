// A draft's changes are never dropped on their way to Hearth (D59). A newer version read while a
// save is out leaves the screen as it is, and the save merges onto it. A screen that closes with
// its last save still out leaves its copy to the screen open meanwhile once that save fails.
// Copies left on this device are sent at the next start, merged onto Jarvis's newer version. Until
// then a send of that draft waits. Runs against a fake Hearth, an in-memory stand-in for IndexedDB
// and fake Web Locks (no DOM here).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftFields } from "./compose.ts";
import type { Unsaved } from "./docStore.ts";
import type { LiveEvent } from "./live.ts";
import type { Approval, MailDraft } from "./types.ts";

/** The unsaved copies this device keeps, by key. */
const kept = vi.hoisted(() => new Map<string, Unsaved<unknown>>());
vi.mock("./docStore.ts", () => ({
  unsavedCopies: async (key: string) =>
    [...kept.values()]
      .filter((k) => k.key === key || k.key.startsWith(`${key}#`))
      .map((k) => structuredClone(k)),
  keptIds: async (prefix: string) => [
    ...new Set(
      [...kept.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length, -5)),
    ),
  ],
  saveUnsaved: async (rec: Unsaved<unknown>) => void kept.set(rec.key, structuredClone(rec)),
  dropUnsaved: async (key: string) => void kept.delete(key),
  takeOverUnsaved: async (rec: Unsaved<unknown> | null, held: Unsaved<unknown>[]) => {
    for (const k of held)
      if (JSON.stringify(kept.get(k.key)) === JSON.stringify(k)) kept.delete(k.key);
    if (rec) kept.set(rec.key, structuredClone(rec));
  },
}));
const feed = vi.hoisted(() => new Set<(e: LiveEvent) => void>());
vi.mock("./live.ts", async (original) => ({
  ...(await original<typeof import("./live.ts")>()),
  onLiveEvent: (fn: (e: LiveEvent) => void) => {
    feed.add(fn);
    return () => feed.delete(fn);
  },
}));

/** The Web Locks this browser holds, each till it's let go; a request waits for one held. */
const locked = new Map<string, Promise<unknown>>();
type Granted = (lock: { name: string } | null) => Promise<unknown>;
const locks = {
  async request(name: string, ...args: [Granted] | [{ ifAvailable?: boolean }, Granted]) {
    const fn = args.length === 2 ? args[1] : args[0];
    if (args.length === 2 && args[0].ifAvailable && locked.has(name)) return fn(null);
    while (locked.has(name)) await locked.get(name);
    const run = fn({ name }).finally(() => locked.delete(name));
    locked.set(name, Promise.allSettled([run]));
    return run;
  },
};

interface Hearth {
  version: number;
  subject: string;
  text: string;
}
/** Draft d1 as Hearth has it; null once it's sent or in the trash. */
let server: Hearth | null;
/** Requests to these actions wait till they're let through. */
const gates = new Map<string, Promise<void>>();
/** The next request to each of these is lost on the way. */
const lose = new Set<string>();
/** Runs as the next save arrives, before it's checked (Jarvis saving first). */
let first: (() => void) | undefined;
/** Every request Hearth got, by action (or approval). */
let asked: string[] = [];

const reply = (body: unknown, status = 200) => Response.json(body, { status });
const draft = (h: Hearth): MailDraft => ({
  id: "d1",
  account: "me@x.example",
  threadId: "t1",
  to: [{ address: "ana@x.example" }],
  cc: [],
  bcc: [],
  subject: h.subject,
  text: h.text,
  updatedAt: "",
  version: h.version,
  by: "jarvis",
});
/** Jarvis (or another screen) saves a newer version. */
const elsewhere = (change: Partial<Hearth>) => {
  server = { ...server!, ...change, version: server!.version + 1 };
};
const gate = (name: string) => {
  let open = () => {};
  gates.set(name, new Promise<void>((done) => (open = done)));
  return () => {
    gates.delete(name);
    open();
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  server = { version: 1, subject: "Re: Lunch", text: "Hi Ana," };
  gates.clear();
  lose.clear();
  first = undefined;
  asked = [];
  feed.clear();
  kept.clear();
  locked.clear();
  const win = Object.assign(new EventTarget(), {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: number) => clearTimeout(t),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { locks });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const name = url.split("/").pop()!;
    asked.push(name);
    await gates.get(name);
    if (lose.delete(name)) throw new TypeError("Failed to fetch");
    if (url.startsWith("/api/approvals/")) return reply({ status: "ok", result: {} });
    const input = JSON.parse(String(init.body));
    if (name === "mail.drafts")
      return reply({ status: "ok", result: server ? [draft(server)] : [] });
    if (!server) return reply({ status: "error", code: "not_found", message: "No draft." }, 404);
    first?.();
    first = undefined;
    if (input.baseVersion !== server.version)
      return reply({ status: "error", code: "conflict", message: "Changed since read." }, 409);
    server = { subject: input.subject, text: input.text, version: server.version + 1 };
    return reply({ status: "ok", result: draft(server) });
  });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A composer with draft d1 open, saved through createSaver as MailCompose saves it. */
async function compose() {
  const { createSaver } = await import("./wholeSave.ts");
  const { ApiError, action } = await import("./api.ts");
  const { draftInput, fieldsOf, mergeDraft } = await import("./compose.ts");
  let shown = blank();
  const saver = createSaver<DraftFields>({
    id: "d1",
    key: "draft:d1",
    noun: "draft",
    action: "mail.draft_update",
    input: (d, baseVersion) => draftInput("d1", d, baseVersion),
    savedAs: (r) => (r as MailDraft).version,
    async get() {
      const d = (await action<MailDraft[]>("mail.drafts", { id: "d1" }))[0];
      if (!d) throw new ApiError(404, "not_found", "No draft with that id.");
      return { title: d.subject, data: fieldsOf(d), version: d.version };
    },
    merge: mergeDraft,
    empty: blank,
    current: () => ({ ...shown }),
    show: (d) => {
      shown = { ...d };
    },
  });
  await saver.load();
  const type = (text: string) => {
    shown = { ...shown, text };
    saver.changed();
  };
  return { saver, type, shown: () => shown };
}
function blank(): DraftFields {
  return { from: null, to: "", cc: "", bcc: "", subject: "", text: "" };
}
/** A copy a composer left here: what it showed, made on Hearth's version 1. */
const leftHere = (key: string, text: string): Unsaved<DraftFields> => {
  const base = { ...blank(), from: "me@x.example", to: "ana@x.example", subject: "Re: Lunch" };
  return { key, data: { ...base, text }, base: { ...base, text: "Hi Ana," }, baseVersion: 1 };
};

describe("a draft's changes on their way to Hearth", () => {
  it("keeps what you typed when a newer version is read while your save is out", async () => {
    const c = await compose();
    c.type("Hi Ana,\nRunning 10 min late.");
    // Jarvis saves a new subject, and its live event has the composer read the draft again.
    elsewhere({ subject: "Re: Lunch (moved)" });
    const reads = gate("mail.drafts");
    const saves = gate("mail.draft_update");
    const reading = c.saver.load();
    // The pause after typing passes: the save goes out on version 1.
    await vi.advanceTimersByTimeAsync(700);
    // The newer version arrives first, then Hearth turns the save down.
    reads();
    await reading;
    expect(c.shown().text).toBe("Hi Ana,\nRunning 10 min late.");
    saves();
    await vi.advanceTimersByTimeAsync(0);
    expect(server).toMatchObject({
      subject: "Re: Lunch (moved)",
      text: "Hi Ana,\nRunning 10 min late.",
    });
    expect(c.shown().text).toBe("Hi Ana,\nRunning 10 min late.");
    expect(kept.size).toBe(0);
  });

  it("takes in what a closing screen kept once its last save fails, though it opened first", async () => {
    const a = await compose();
    a.type("Hi Ana,\nRunning late.");
    await vi.advanceTimersByTimeAsync(0);
    // Closed before the pause is up: its last save goes out, and is held up on the way.
    const saves = gate("mail.draft_update");
    const closing = a.saver.close();
    // Opened again meanwhile: the closing screen holds its copy, so this one shows Hearth's.
    const b = await compose();
    expect(b.shown().text).toBe("Hi Ana,");
    // The last save is lost: the copy stays, and goes to the screen that's open.
    lose.add("mail.draft_update");
    saves();
    await closing;
    await vi.advanceTimersByTimeAsync(0);
    expect(b.shown().text).toBe("Hi Ana,\nRunning late.");
    expect(server?.text).toBe("Hi Ana,\nRunning late.");
    expect(kept.size).toBe(0);
  });
});

describe("drafts kept on this device", () => {
  it("sends a closed composer's changes onto Jarvis's newer version, an open one's left be", async () => {
    kept.set("draft:d1#aaaa", leftHere("draft:d1#aaaa", "Hi Ana,\nRunning late."));
    // Another draft is open on this device: its screen saves it.
    kept.set("draft:d2#bbbb", leftHere("draft:d2#bbbb", "Still typing"));
    void locks.request("draft:d2#bbbb", () => new Promise(() => {}));
    elsewhere({ subject: "Re: Lunch (moved)" });
    // Jarvis saves again as the copy goes, so it's merged a second time.
    first = () => elsewhere({ text: "Hi Ana,\nSee you at noon." });
    const { sendKeptDrafts } = await import("./keptDrafts.ts");
    await sendKeptDrafts();
    expect(server).toEqual({
      version: 4,
      subject: "Re: Lunch (moved)",
      text: "Hi Ana,\nRunning late.\nSee you at noon.",
    });
    expect([...kept.keys()]).toEqual(["draft:d2#bbbb"]);
    expect(asked.filter((n) => n === "mail.draft_update")).toHaveLength(2);
  });

  it("keeps the copy of a draft Hearth no longer has, or can't be reached for", async () => {
    kept.set("draft:d1#aaaa", leftHere("draft:d1#aaaa", "Hi Ana,\nRunning late."));
    const { sendKeptDrafts } = await import("./keptDrafts.ts");
    lose.add("mail.drafts");
    await sendKeptDrafts();
    server = null;
    await sendKeptDrafts();
    expect([...kept.keys()]).toEqual(["draft:d1#aaaa"]);
  });

  it("won't send a draft on your yes while changes to it wait here", async () => {
    const { queryClient } = await import("./live.ts");
    const { decideQuietly } = await import("./approvals.ts");
    const { KEPT_HERE } = await import("./keptDrafts.ts");
    const send = { id: "ap1", action: "mail.send", input: { id: "d1" } } as Approval;
    queryClient.setQueryData(["approval.list", { status: "pending", limit: 50 }], [send]);
    kept.set("draft:d1#aaaa", leftHere("draft:d1#aaaa", "Hi Ana,\nRunning late."));
    expect(await decideQuietly("ap1", "approve")).toEqual({
      outcome: "failed",
      message: KEPT_HERE,
    });
    expect(asked).toEqual([]);
    // A no still goes, and so does the yes once the changes are in.
    expect((await decideQuietly("ap1", "deny")).outcome).toBe("done");
    kept.clear();
    queryClient.setQueryData(["approval.list", {}], [{ ...send, id: "ap2" }]);
    expect((await decideQuietly("ap2", "approve")).outcome).toBe("done");
    expect(asked).toEqual(["ap1", "ap2"]);
  });
});
