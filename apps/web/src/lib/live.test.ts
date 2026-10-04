// The live feed coming back by itself: one feed at a time however many wake-ups arrive, a
// refused feed that turns out to be a signed-out session goes to sign-in, and a feed that comes
// back picks up after the last event it saw. Runs against a fake browser (no DOM in these tests).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = FakeSource.CONNECTING;
  private handlers = new Map<string, ((m: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(kind: string, fn: (m: { data: string }) => void) {
    this.handlers.set(kind, [...(this.handlers.get(kind) ?? []), fn]);
  }
  close() {
    this.readyState = FakeSource.CLOSED;
  }
  emit(kind: string, data: unknown = {}) {
    if (kind === "ready") this.readyState = FakeSource.OPEN;
    for (const fn of this.handlers.get(kind) ?? []) fn({ data: JSON.stringify(data) });
  }
  /** An error reply (a 502, a 401): the browser gives up on this one. */
  refuse() {
    this.readyState = FakeSource.CLOSED;
    this.emit("error");
  }
}
const open = () => FakeSource.all.filter((s) => s.readyState !== FakeSource.CLOSED);

/** Answers to /api/auth/me, in the order they're asked for; each waits until answered. */
let me: ((signedIn: boolean | null) => void)[] = [];
const wakeHandlers: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  me = [];
  wakeHandlers.length = 0;
  const target = {
    addEventListener: (_kind: string, fn: () => void) => wakeHandlers.push(fn),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: number) => clearTimeout(t),
  };
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: target.addEventListener,
  });
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("fetch", () => {
    return new Promise((resolve, reject) => {
      me.push((signedIn) =>
        signedIn === null
          ? reject(new TypeError("Failed to fetch"))
          : resolve(Response.json({ signedIn, principal: null, needsSetup: false })),
      );
    });
  });
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function load() {
  const { live, queryClient } = await import("./live.ts");
  const api = await import("./api.ts");
  return { live, queryClient, api };
}
/** Lets pending promises (fetch, res.json()) settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("the live feed", () => {
  it("opens one feed however many wake-ups arrive while it reconnects", async () => {
    const { live } = await load();
    live.start();
    FakeSource.all[0]!.emit("ready", { after: 7 });
    FakeSource.all[0]!.refuse();
    // Back online and back on screen, both while the first try is still asking who you are.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(me).toHaveLength(1);
    for (const wake of wakeHandlers) wake();
    expect(me).toHaveLength(3);
    for (const answer of me) answer(true);
    await settle();
    expect(open()).toHaveLength(1);
    expect(open()[0]!.url).toBe("/api/events?after=7");
    live.stop();
  });

  it("says when it's been down a few seconds, and stops saying so once it's back", async () => {
    const { live, queryClient } = await load();
    const refetch = vi.spyOn(queryClient, "invalidateQueries");
    live.start();
    FakeSource.all[0]!.emit("ready", { after: 0 });
    await vi.advanceTimersByTimeAsync(500);
    // The first connection doesn't refetch what every screen just read.
    expect(refetch).not.toHaveBeenCalled();
    FakeSource.all[0]!.refuse();
    expect(live.connected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    me.shift()!(null);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(live.reconnecting()).toBe(true);
    // Tries again, backing off, until Hearth answers.
    while (me.length === 0) await vi.advanceTimersByTimeAsync(500);
    me.shift()!(true);
    await settle();
    open()[0]!.emit("ready", { after: 3 });
    expect(live.reconnecting()).toBe(false);
    expect(live.connected()).toBe(true);
    // A gap may have missed changes no event tells of: everything is read again, once.
    await vi.advanceTimersByTimeAsync(500);
    expect(refetch).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it("goes to sign-in when the feed was refused because you're signed out", async () => {
    const { live, api } = await load();
    const signedOut = vi.fn(() => live.stop());
    api.setSignedOutHandler(signedOut);
    live.start();
    FakeSource.all[0]!.refuse();
    await vi.advanceTimersByTimeAsync(1_000);
    me.shift()!(false);
    await settle();
    expect(signedOut).toHaveBeenCalledOnce();
    expect(open()).toHaveLength(0);
  });

  it("gives up on a feed that's gone silent and opens a new one", async () => {
    const { live } = await load();
    live.start();
    FakeSource.all[0]!.emit("ready", { after: 1 });
    await vi.advanceTimersByTimeAsync(44_000);
    FakeSource.all[0]!.emit("ping");
    await vi.advanceTimersByTimeAsync(44_000);
    expect(me).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSource.all[0]!.readyState).toBe(FakeSource.CLOSED);
    await vi.advanceTimersByTimeAsync(1_000);
    me.shift()!(true);
    await settle();
    expect(open()).toHaveLength(1);
    live.stop();
  });
});
