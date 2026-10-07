// What's said as time from now moves on by itself each minute, with nothing read again: a row
// kept as it was (keepUnchanged.ts) still says "2 min ago" once it's been two minutes.
import { createMemo, createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ago, due } from "./format.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

describe("the clock", () => {
  afterEach(() => vi.useRealTimers());

  it("moves a row's time on each minute, and makes a due time late, with no read again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 9, 0, 30));
    const posted = new Date(2026, 9, 7, 8, 59).toISOString();
    const dueAt = new Date(2026, 9, 7, 9, 2).toISOString();
    createRoot((dispose) => {
      // As a row shows them: worked out once, and again only when something they read moves.
      const said = createMemo(() => ago(posted));
      const late = createMemo(() => due(dueAt, false)?.overdue);
      expect(said()).toBe("1 min ago");
      expect(late()).toBe(false);
      vi.advanceTimersByTime(60_000);
      expect(said()).toBe("2 min ago");
      vi.advanceTimersByTime(2 * 60_000);
      expect(said()).toBe("4 min ago");
      expect(late()).toBe(true);
      dispose();
    });
  });
});
