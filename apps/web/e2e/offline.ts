// End-to-end check of the service worker (apps/web/public/sw.js): with Hearth stopped, or taking
// connections and never answering, the app still opens from the last page seen, says Hearth can't
// be reached, and comes back by itself once Hearth does, in the same page. resilience.ts fakes
// failures with page.route, which needs the service worker out of the way; this one starts and
// stops a real server instead, so it runs its own (development login, on HEARTH_E2E_PORT).
//
//   pnpm build:web
//   HEARTH_DATABASE_URL=postgres://... HEARTH_E2E_PORT=4404 node apps/web/e2e/offline.ts
//
// HEARTH_E2E_CHROME points at a Chromium to use instead of Playwright's own download.

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.HEARTH_E2E_PORT ?? 4404);
const base = `http://localhost:${port}`;
const repo = join(import.meta.dirname, "../../..");
if (!process.env.HEARTH_DATABASE_URL) throw new Error("Set HEARTH_DATABASE_URL.");

let hearth: ChildProcess | null = null;
let silent: Server | null = null;
const held: Socket[] = [];

async function start() {
  hearth = spawn(process.execPath, [join(repo, "apps/cli/src/main.ts"), "serve"], {
    cwd: repo,
    env: {
      ...process.env,
      HEARTH_WEB_DIST: join(repo, "apps/web/dist"),
      HEARTH_DEV_AUTH: "1",
      HEARTH_PORT: String(port),
      HEARTH_ORIGIN: base,
      HEARTH_CHROME_LAUNCH: "off",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 60; i++) {
    if (
      await fetch(`${base}/api/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Hearth didn't start");
}
async function stop() {
  const h = hearth;
  hearth = null;
  if (!h || h.exitCode !== null) return;
  const exited = new Promise((r) => h.once("exit", r));
  h.kill();
  // Hearth gives up on a hung stop itself after 15 s (apps/cli/src/main.ts); this is the backstop.
  const limit = new Promise<"hung">((r) => setTimeout(() => r("hung"), 20_000).unref());
  if ((await Promise.race([exited, limit])) === "hung") {
    h.kill("SIGKILL");
    throw new Error("Hearth didn't stop within 20 s of being asked");
  }
}
/** Something on Hearth's port that takes connections and never answers (a PC half asleep). */
async function goSilent() {
  silent = createServer((s) => {
    s.on("error", () => {});
    held.push(s);
  });
  await new Promise<void>((r) => silent!.listen(port, "127.0.0.1", r));
}
async function endSilence() {
  for (const s of held.splice(0)) s.destroy();
  if (silent) await new Promise((r) => silent!.close(r));
  silent = null;
}

const unreachable = { name: "Can't reach Hearth" } as const;
async function step(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`✓ ${name}`);
}

const browser = await chromium.launch(
  process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {},
);
const page = await browser.newPage();
try {
  await step("the service worker keeps this build's page and files", async () => {
    await start();
    await page.goto(base);
    // (These checks are typed for Node, not the browser, hence the casts and the text below. A
    // text predicate here would be eval'd, which the app's CSP refuses.)
    type Page = { navigator: { serviceWorker: { controller: unknown } } };
    await page.waitForFunction(
      () => (globalThis as unknown as Page).navigator.serviceWorker.controller !== null,
      null,
      { timeout: 15_000 },
    );
    await page.reload();
    await page.getByRole("heading", { name: "Inbox" }).waitFor();
    const cached = (await page.evaluate(`(async () => {
      const out = {};
      for (const k of await caches.keys())
        out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
      return out;
    })()`)) as Record<string, string[]>;
    if (!cached["hearth-shell-v2"]?.includes("/")) throw new Error("the page isn't kept");
    if (!cached["hearth-assets"]?.some((p) => p.startsWith("/assets/index-")))
      throw new Error("the build's files aren't kept");
  });

  await step("a file opened as a page doesn't replace the kept page", async () => {
    await page.goto(`${base}/version.json`);
    // Saving happens after the file shows; give it the time it would take.
    await page.waitForTimeout(1_000);
    const kept = await page.evaluate(`(async () => {
      const hit = await (await caches.open("hearth-shell-v2")).match("/");
      return hit ? hit.headers.get("content-type") : null;
    })()`);
    if (!String(kept).startsWith("text/html")) throw new Error(`the kept page is now ${kept}`);
  });

  await step("Hearth stopped: the last page opens and says so", async () => {
    await stop();
    await page.goto(base, { timeout: 10_000 });
    await page.getByRole("heading", unreachable).waitFor({ timeout: 10_000 });
  });

  await step("Hearth not answering: the last page opens within a few seconds", async () => {
    await goSilent();
    const t0 = Date.now();
    await page.reload({ timeout: 15_000 });
    const took = Date.now() - t0;
    // The service worker's 3 s wait (NAVIGATE_TIMEOUT_MS) and 3 s to spare; waiting on Hearth
    // instead runs to the reload's 15 s. A bound between two timers isn't scaled for a slow PC.
    if (took > 6_000) throw new Error(`the page took ${took} ms`);
    await page.getByRole("heading", unreachable).waitFor({ timeout: 20_000 });
    await endSilence();
  });

  await step("Hearth back: the app comes back by itself, without a reload", async () => {
    await page.evaluate("window.sameLoad = true");
    await start();
    await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 40_000 });
    if (!(await page.evaluate("window.sameLoad === true"))) throw new Error("the page reloaded");
  });
  console.log("Offline checks passed.");
} finally {
  await browser.close();
  await endSilence();
  await stop();
}
