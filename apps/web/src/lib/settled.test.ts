// A button covers what you had time to see: a list that grew just before a tap isn't what the tap
// approves until it has stayed put a moment; one that shrank is taken on at once.
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettled, noneNew, SETTLE_MS, sameIds } from "./settled.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (...ids: string[]) =>
  createRoot((dispose) => {
    const [live, setLive] = createSignal<string[]>(ids);
    const shown = createSettled(live, { same: sameIds, safe: noneNew });
    return { shown, setLive, dispose };
  });

describe("createSettled", () => {
  it("doesn't let a tap cover an approval that arrived just before it", () => {
    const { shown, setLive, dispose } = setup("a", "b");
    expect(shown.armed()).toEqual(["a", "b"]);
    // A new one lands below the fold while you're reading.
    setLive(["a", "b", "c"]);
    expect(shown.settling()).toBe(true);
    expect(shown.armed()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(shown.armed()).toEqual(["a", "b"]);
    // Once it has been on screen a moment, the button covers it too.
    vi.advanceTimersByTime(1);
    expect(shown.settling()).toBe(false);
    expect(shown.armed()).toEqual(["a", "b", "c"]);
    expect(shown.changed()).toBe(true);
    dispose();
  });

  it("waits again from the start when it changes again while it waits", () => {
    const { shown, setLive, dispose } = setup("a", "b");
    setLive(["a", "b", "c"]);
    vi.advanceTimersByTime(SETTLE_MS - 100);
    setLive(["a", "b", "c", "d"]);
    vi.advanceTimersByTime(SETTLE_MS - 100);
    expect(shown.armed()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(100);
    expect(shown.armed()).toEqual(["a", "b", "c", "d"]);
    dispose();
  });

  it("takes on at once one that left, and stops waiting when the new one goes again", () => {
    const { shown, setLive, dispose } = setup("a", "b", "c");
    setLive(["a", "c"]);
    expect(shown.settling()).toBe(false);
    expect(shown.armed()).toEqual(["a", "c"]);
    setLive(["a", "c", "d"]);
    expect(shown.settling()).toBe(true);
    setLive(["a", "c"]);
    expect(shown.settling()).toBe(false);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(shown.armed()).toEqual(["a", "c"]);
    expect(shown.changed()).toBe(true);
    dispose();
  });

  it("covers nothing at first when told what's there has only just come", () => {
    const { shown, dispose } = createRoot((dispose) => {
      const [live] = createSignal(["a", "b"]);
      return { shown: createSettled(live, { same: sameIds, safe: noneNew, initial: [] }), dispose };
    });
    expect(shown.armed()).toEqual([]);
    expect(shown.settling()).toBe(true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(shown.armed()).toEqual(["a", "b"]);
    dispose();
  });
});
