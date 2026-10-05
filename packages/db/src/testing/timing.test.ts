import { afterEach, describe, expect, it, vi } from "vitest";
import { fastest, parseSlack } from "./timing.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("timed checks", () => {
  it("take HEARTH_PERF_SLACK from 1 to 10, and refuse anything else", () => {
    expect(parseSlack(undefined)).toBe(1);
    expect(parseSlack(" ")).toBe(1);
    expect(parseSlack("3")).toBe(3);
    expect(parseSlack("2.5")).toBe(2.5);
    for (const wrong of ["0.5", "11", "three", "Infinity"])
      expect(() => parseSlack(wrong)).toThrow(/from 1 to 10/);
  });

  it("count the fastest run, not the warm-up or the slow ones", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const seen: number[] = [];
    // Each run takes 30 ms but the fourth (the second timed one), which takes 5.
    const timing = fastest(
      async (n) => {
        seen.push(n);
        await new Promise((r) => setTimeout(r, n === 3 ? 5 : 30));
      },
      { runs: 3, warmup: 2 },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await timing).toBe(5);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });
});
