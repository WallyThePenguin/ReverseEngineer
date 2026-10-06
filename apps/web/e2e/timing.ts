// How long Hearth takes to show you something, in a real browser, for the numbers in a PR (not a
// CI gate): the first open with nothing cached, a second open with everything cached, and each
// place once you're in. At a computer's size, and at a phone's on a slower network and CPU, as
// the phone reaches Hearth over Tailscale. Run it against a seeded Hearth
// (apps/server/src/testing/preview.ts), never the one holding your data.
//
//   HEARTH_E2E_URL=http://localhost:4473 HEARTH_E2E_CHROME=<headless shell> node apps/web/e2e/timing.ts
//
// "Shown" is when a pane is drawn and none of it is still loading; times are medians of RUNS.

import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

const base = process.env.HEARTH_E2E_URL ?? "http://localhost:4473";
const RUNS = Number(process.env.HEARTH_TIMING_RUNS ?? 3);
const PLACES = ["inbox", "mail", "tasks", "calendar", "notes", "people"];

interface Profile {
  name: string;
  viewport: { width: number; height: number };
  mobile: boolean;
  /** Simulated: round trip in ms, bytes per second, and how many times slower the CPU is. */
  slow?: { latency: number; throughput: number; cpu: number };
}
const PROFILES: Profile[] = [
  { name: "computer", viewport: { width: 1280, height: 800 }, mobile: false },
  {
    name: "phone (simulated: 80 ms, 10 Mbit/s, 4x slower CPU)",
    viewport: { width: 390, height: 844 },
    mobile: true,
    slow: { latency: 80, throughput: 1_250_000, cpu: 4 },
  },
];

/**
 * What the page code below uses of the browser. This file is typed for Node, hence the casts; the
 * code is passed as functions, not text, because Hearth's CSP rightly refuses eval.
 */
interface Element {
  innerText: string;
  textContent: string | null;
  querySelectorAll(selector: string): Iterable<Element>;
}
interface InPage {
  document: {
    querySelectorAll(selector: string): Iterable<Element>;
    querySelector(s: string): unknown;
  };
  history: { pushState(state: null, unused: string, url: string): void };
  dispatchEvent(event: unknown): void;
  PopStateEvent: new (type: string) => unknown;
  navigator: { serviceWorker?: { ready: Promise<unknown> } };
}

/** The page's clock once a pane is drawn and nothing in it says it's still loading; false before. */
const SHOWN = () => {
  const panes = [...(globalThis as unknown as InPage).document.querySelectorAll("section")];
  const shown =
    panes.length > 0 &&
    panes.every(
      (p) =>
        p.innerText.trim().length > 0 &&
        ![...p.querySelectorAll(".sr-only")].some((s) => s.textContent?.includes("Loading")),
    );
  return shown ? performance.now() : false;
};
/** True once the frame (sidebar or tab bar) is up, whatever the panes are doing. */
const FRAME = () => (globalThis as unknown as InPage).document.querySelector("nav") !== null;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

async function contextFor(browser: Browser, p: Profile): Promise<BrowserContext> {
  return browser.newContext({ viewport: p.viewport, isMobile: p.mobile, hasTouch: p.mobile });
}

async function slowDown(page: Page, p: Profile) {
  if (!p.slow) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: p.slow.latency,
    downloadThroughput: p.slow.throughput,
    uploadThroughput: p.slow.throughput,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.slow.cpu });
}

/** Opens `path` and times the frame, then the first place shown. */
async function open(page: Page, path: string, reload: boolean) {
  const t0 = Date.now();
  if (reload) await page.reload({ waitUntil: "commit" });
  else await page.goto(base + path, { waitUntil: "commit" });
  await page.waitForFunction(FRAME, null, { polling: 16, timeout: 60_000 });
  const frame = Date.now() - t0;
  await page.waitForFunction(SHOWN, null, { polling: 16, timeout: 60_000 });
  const shown = Date.now() - t0;
  const fcp = await page.evaluate(
    () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
  );
  return { frame, shown, fcp: fcp === null ? null : Math.round(fcp) };
}

/** Moves to a place the way the app does (its address changes, then it draws), and times it. */
async function visit(page: Page, place: string) {
  const t0 = await page.evaluate((to) => {
    const web = globalThis as unknown as InPage;
    const t = performance.now();
    web.history.pushState(null, "", `/${to}`);
    web.dispatchEvent(new web.PopStateEvent("popstate"));
    return t;
  }, place);
  // The page's own clock, read the moment it's shown.
  const done = await page.waitForFunction(SHOWN, null, { polling: 16, timeout: 60_000 });
  return Math.round((await done.jsonValue()) as number) - Math.round(t0);
}

async function measure(browser: Browser, p: Profile) {
  const cold: { frame: number; shown: number; fcp: number | null }[] = [];
  const warm: typeof cold = [];
  const places: Record<string, number[]> = {};
  const slowest = new Map<string, number[]>();
  for (let run = 0; run < RUNS; run++) {
    const context = await contextFor(browser, p);
    const page = await context.newPage();
    await slowDown(page, p);
    const calls: { url: string; ms: number }[] = [];
    page.on("requestfinished", (r) => {
      const t = r.timing();
      if (r.url().includes("/api/")) calls.push({ url: r.url(), ms: t.responseEnd });
    });
    cold.push(await open(page, "/", false));
    for (const c of calls) {
      const name = new URL(c.url).pathname.replace("/api/actions/", "");
      slowest.set(name, [...(slowest.get(name) ?? []), c.ms]);
    }
    // The service worker has the page by now: a second open is the cached one.
    await page.evaluate(() =>
      Promise.race([
        (globalThis as unknown as InPage).navigator.serviceWorker?.ready.then(() => null),
        new Promise((r) => setTimeout(r, 5000)),
      ]),
    );
    warm.push(await open(page, "/", true));
    for (const place of PLACES) {
      // Each place's first visit, then back to the start so the next one is a first visit too.
      places[place] = [...(places[place] ?? []), await visit(page, place)];
    }
    await context.close();
  }
  return {
    profile: p.name,
    cold: {
      frame: median(cold.map((c) => c.frame)),
      shown: median(cold.map((c) => c.shown)),
      fcp: median(cold.map((c) => c.fcp ?? Number.NaN)),
    },
    warm: {
      frame: median(warm.map((c) => c.frame)),
      shown: median(warm.map((c) => c.shown)),
      fcp: median(warm.map((c) => c.fcp ?? Number.NaN)),
    },
    places: Object.fromEntries(Object.entries(places).map(([k, v]) => [k, median(v)])),
    slowestCalls: [...slowest.entries()]
      .map(([name, ms]) => ({ name, ms: Math.round(median(ms)) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8),
  };
}

const browser = await chromium.launch({
  ...(process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {}),
});
try {
  const results = [];
  for (const p of PROFILES) results.push(await measure(browser, p));
  const s = (ms: number) => (Number.isNaN(ms) ? "–" : `${(ms / 1000).toFixed(2)} s`);
  for (const r of results) {
    console.log(`\n### ${r.profile} (median of ${RUNS})\n`);
    console.log("| | frame up | first paint | place shown |\n|---|---|---|---|");
    console.log(
      `| first open (nothing cached) | ${s(r.cold.frame)} | ${s(r.cold.fcp)} | ${s(r.cold.shown)} |`,
    );
    console.log(
      `| second open (cached) | ${s(r.warm.frame)} | ${s(r.warm.fcp)} | ${s(r.warm.shown)} |`,
    );
    console.log(
      `\nMoving to each place: ${Object.entries(r.places)
        .map(([k, v]) => `${k} ${s(v)}`)
        .join(", ")}`,
    );
    console.log(
      `Slowest calls on first open: ${r.slowestCalls.map((c) => `${c.name} ${c.ms} ms`).join(", ")}`,
    );
  }
  if (process.env.HEARTH_TIMING_OUT) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(process.env.HEARTH_TIMING_OUT, JSON.stringify(results, null, 2));
  }
} finally {
  await browser.close();
}
