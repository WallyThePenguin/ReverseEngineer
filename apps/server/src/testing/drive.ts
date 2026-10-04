// The driver's tests share this: a Chromium with the test pages, each driver call timed, and the
// timings written out at the end (p50 and p95, B1's target is a p50 under a second).
import { appendFileSync } from "node:fs";
import { chromiumForTests, chromiumPath } from "@hearth/modules/chromium";
import { afterAll, beforeAll } from "vitest";
import { fixtures } from "../browser/driver/fixtures.ts";
import { TestChrome } from "./chrome.ts";

export interface Harness {
  readonly run: boolean;
  chrome(): TestChrome;
  // biome-ignore lint/suspicious/noExplicitAny: tests read what they expect from results.
  drive<T = Record<string, any>>(op: string, params: Record<string, unknown>): Promise<T>;
}

/** The ref a read gave the thing named `label`. */
export function refOf(text: string, label: string): string {
  const m = new RegExp(`"${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" \\[(ref_\\d+)\\]`).exec(
    text,
  );
  if (!m?.[1]) throw new Error(`No "${label}" in:\n${text}`);
  return m[1];
}

export function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export function useChrome(name: string): Harness {
  const run = chromiumForTests();
  let chrome: TestChrome | null = null;
  const timings: { op: string; ms: number }[] = [];
  beforeAll(async () => {
    if (!run) return;
    chrome = await TestChrome.launch(
      chromiumPath() as string,
      fixtures(() => chrome?.server.port ?? 0),
    );
  }, 30_000);
  afterAll(async () => {
    await chrome?.close();
    if (!timings.length) return;
    const ms = timings.map((t) => t.ms).sort((a, b) => a - b);
    const line = `driver timings (${name}): ${ms.length} calls, p50 ${percentile(ms, 0.5).toFixed(0)} ms, p95 ${percentile(ms, 0.95).toFixed(0)} ms, max ${percentile(ms, 1).toFixed(0)} ms`;
    const byOp = new Map<string, number[]>();
    for (const t of timings) byOp.set(t.op, [...(byOp.get(t.op) ?? []), t.ms]);
    const detail = [...byOp].map(
      ([op, list]) => `  ${op}: ${list.map((n) => n.toFixed(0)).join(", ")} ms`,
    );
    console.log([line, ...detail].join("\n"));
    // HEARTH_DRIVER_TIMINGS names a file to collect every run's timings in.
    if (process.env.HEARTH_DRIVER_TIMINGS)
      appendFileSync(
        process.env.HEARTH_DRIVER_TIMINGS,
        timings.map((t) => `${name}\t${t.op}\t${t.ms.toFixed(1)}\n`).join(""),
      );
  });
  return {
    run,
    chrome: () => {
      if (!chrome) throw new Error("Chromium didn't start");
      return chrome;
    },
    async drive(op, params) {
      const start = performance.now();
      try {
        return await (chrome as TestChrome).call(`driver.${op}`, params);
      } finally {
        timings.push({ op, ms: performance.now() - start });
      }
    },
  };
}
