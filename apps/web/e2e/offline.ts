// End-to-end check of the service worker (apps/web/public/sw.js): with Hearth stopped, or taking
// connections and never answering, the app still opens from the last page seen, says Hearth can't
// be reached, and comes back by itself once Hearth does, in the same page; an open page moves on
// to a new build; and quick capture always comes from Hearth. resilience.ts fakes failures with page.route, which needs the service worker
// out of the way; this one starts and stops a real server instead, so it runs its own (development
// login, on HEARTH_E2E_PORT), on copies of the build stamped as newer ones.
//
//   pnpm build:web
//   HEARTH_DATABASE_URL=postgres://... HEARTH_E2E_PORT=4404 node apps/web/e2e/offline.ts
//
// HEARTH_E2E_CHROME points at a Chromium to use instead of Playwright's own download.

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { home } from "./home.ts";

const port = Number(process.env.HEARTH_E2E_PORT ?? 4404);
const base = `http://localhost:${port}`;
const repo = join(import.meta.dirname, "../../..");
if (!process.env.HEARTH_DATABASE_URL) throw new Error("Set HEARTH_DATABASE_URL.");

let hearth: ChildProcess | null = null;
let silent: Server | null = null;
const held: Socket[] = [];

const built = join(repo, "apps/web/dist");
const copies = mkdtempSync(join(tmpdir(), "hearth-offline-"));
/**
 * A copy of the build that Hearth and its page call `build`. `page` edits the page's HTML; with
 * `worker`, its service worker is a new one too. A changed file's precompressed copies go, or
 * they'd be served instead.
 */
function stamped(build: string, edit: { page?: (html: string) => string; worker?: true } = {}) {
  const dist = join(copies, build);
  const file = (name: string, change: (text: string) => string) => {
    writeFileSync(join(dist, name), change(readFileSync(join(dist, name), "utf8")));
    for (const z of [".br", ".gz"]) rmSync(join(dist, name + z), { force: true });
  };
  cpSync(built, dist, { recursive: true });
  file("version.json", (v) => JSON.stringify({ ...JSON.parse(v), sha: build }));
  file("index.html", (html) =>
    (edit.page ?? ((h) => h))(html.replace(/(name="hearth-build" content=")[^"]*/, `$1${build}`)),
  );
  if (edit.worker) file("sw.js", (js) => `${js}// ${build}`);
  return dist;
}

async function start(dist = built) {
  hearth = spawn(process.execPath, [join(repo, "apps/cli/src/main.ts"), "serve"], {
    cwd: repo,
    windowsHide: true,
    env: {
      ...process.env,
      HEARTH_WEB_DIST: dist,
      HEARTH_DEV_AUTH: "1",
      HEARTH_PORT: String(port),
      HEARTH_ORIGIN: base,
      HEARTH_CHROME_LAUNCH: "off",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Up to 90 s: a busy PC starts it slowly.
  for (let i = 0; i < 180; i++) {
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
type Doc = { document: { querySelector(q: string): { content: string } | null } };
const buildShown = `document.querySelector('meta[name="hearth-build"]').content`;
/** Waits for the open page to be `build`'s. */
const shows = (build: string, timeout = 20_000) =>
  page.waitForFunction(
    (want) =>
      (globalThis as unknown as Doc).document.querySelector('meta[name="hearth-build"]')
        ?.content === want,
    build,
    { timeout },
  );
/** The build of the page the service worker keeps, and whether one is noted as started. */
const kept = async () =>
  (await page.evaluate(`(async () => {
    const shell = await caches.open("hearth-shell-v3");
    const page = await shell.match("/");
    const html = page ? await page.text() : "";
    const started = await shell.match("/.started");
    return {
      build: html.match(/name="hearth-build" content="([^"]+)"/)?.[1] ?? null,
      started: started ? await started.text() : null,
    };
  })()`)) as { build: string | null; started: string | null };
/** The kept page, seen to start before, says it's `build`'s (its files are this one's, so it runs). */
const keepAs = (build: string) =>
  page.evaluate(`(async () => {
    const shell = await caches.open("hearth-shell-v3");
    const kept = await shell.match("/");
    const html = (await kept.text()).replace(/(name="hearth-build" content=")[^"]*/, "$1${build}");
    await shell.put("/", new Response(html, { headers: kept.headers }));
    await shell.put("/.started", new Response("${build}"));
  })()`);
/** Counts the page's loads while `fn` runs, and a moment after. */
async function loadsDuring(fn: () => Promise<unknown>) {
  let loads = 0;
  const count = (f: unknown) => {
    if (f === page.mainFrame()) loads++;
  };
  page.on("framenavigated", count);
  try {
    await fn();
    await page.waitForTimeout(1_500);
  } finally {
    page.off("framenavigated", count);
  }
  return loads;
}
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
    await home(page).waitFor();
    const cached = (await page.evaluate(`(async () => {
      const out = {};
      for (const k of await caches.keys())
        out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
      return out;
    })()`)) as Record<string, string[]>;
    if (!cached["hearth-shell-v3"]?.includes("/")) throw new Error("the page isn't kept");
    const files = Object.entries(cached).find(([k]) => k.startsWith("hearth-assets:"))?.[1];
    if (!files?.some((p) => p.startsWith("/assets/index-")))
      throw new Error("the build's files aren't kept");
  });

  await step("a file opened as a page doesn't replace the kept page", async () => {
    await page.goto(`${base}/version.json`);
    // Saving happens after the file shows; give it the time it would take.
    await page.waitForTimeout(1_000);
    const kept = await page.evaluate(`(async () => {
      const hit = await (await caches.open("hearth-shell-v3")).match("/");
      return hit ? hit.headers.get("content-type") : null;
    })()`);
    if (!String(kept).startsWith("text/html")) throw new Error(`the kept page is now ${kept}`);
  });

  let running = "";
  await step(
    "a page kept from before an update opens, then reloads into Hearth's build",
    async () => {
      // Back from the file to the app, which says which build it is.
      await page.goto(base);
      await home(page).waitFor();
      running = (await page.evaluate(buildShown)) as string;
      await keepAs("older");
      // It opens at once from the kept page, hears Hearth runs another build and, as nothing's been
      // done on it yet, reloads into it, once, from Hearth.
      const loads = await loadsDuring(async () => {
        await page.goto(`${base}/tasks`);
        await shows(running);
      });
      if (loads !== 2) throw new Error(`the page loaded ${loads} times`);
      if (await page.getByText("Hearth was updated.").isVisible())
        throw new Error("it said so instead of reloading");
    },
  );

  await step(
    "a kept page whose build never started isn't opened; files of old builds go",
    async () => {
      // Say an update's page was kept but its code never ran (a broken build): it can't move itself
      // on, so Hearth's own page opens instead. And files are kept for a build long gone.
      await page.evaluate(`(async () => {
      const main = document.querySelector('script[src^="/assets/index-"]').getAttribute("src");
      const shell = await caches.open("hearth-shell-v3");
      const kept = await shell.match("/");
      const html = (await kept.text())
        .replace(main, "/assets/index-broken.js")
        .replace(/(name="hearth-build" content=")[^"]*/, "$1broken");
      await shell.put("/", new Response(html, { headers: kept.headers }));
      const gone = await caches.open("hearth-assets:ancient");
      await gone.put("/assets/index-ancient.js", new Response(""));
    })()`);
      await page.goto(base);
      await home(page).waitFor({ timeout: 15_000 });
      // Hearth's page replaces the kept one after it shows; give it the time that takes.
      await page.waitForTimeout(1_000);
      const names = (await page.evaluate("caches.keys()")) as string[];
      if (names.includes("hearth-assets:ancient"))
        throw new Error("a build long gone keeps its files");
      if (!names.includes(`hearth-assets:${running}`)) throw new Error("this build's files went");
    },
  );

  await step("an open page you come back to moves on to a new build, from Hearth", async () => {
    // Updated while the page sat in the background (the desktop window in the tray): coming back
    // reloads into the new build, not into the page kept, which is the one already open.
    await stop();
    await start(stamped("newer"));
    await page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
    await shows("newer");
    await home(page).waitFor();
    if (await page.getByText("Hearth was updated.").isVisible())
      throw new Error("it said so instead of moving on");
  });

  await step("quick capture opens from Hearth, never from a page kept from before", async () => {
    // The desktop app's small windows are typed into as they open: one opened from an older
    // build's kept page would reload into the new one under your first keys.
    await keepAs("older");
    const loads = await loadsDuring(() => page.goto(`${base}/capture`));
    if ((await page.evaluate(buildShown)) !== "newer") throw new Error("the kept page opened");
    if (loads !== 1) throw new Error(`the page loaded ${loads} times`);
    await page.goto(base);
    await home(page).waitFor();
  });

  await step("an update whose files couldn't all be fetched isn't kept", async () => {
    // Its stylesheet can't be had (the connection dropping halfway, say): kept, its page would
    // open without it with Hearth out of reach. Taken in by a new service worker, as an update is.
    const newest = stamped("newest", {
      page: (html) => html.replace(/href="\/assets\/[^"]+\.css"/, 'href="/assets/index-gone.css"'),
      worker: true,
    });
    await stop();
    await start(newest);
    await page.evaluate(`(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const taken = new Promise((r) =>
        navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }),
      );
      await reg.update();
      await taken;
    })()`);
    const now = await kept();
    if (now.build !== "newer") throw new Error(`the kept page is ${now.build}'s`);
    // And the next page opened comes from Hearth first.
    if (now.started) throw new Error(`${now.started} is still noted as started`);
  });

  await step("Hearth stopped: the last page that works opens and says so", async () => {
    await stop();
    await page.goto(base, { timeout: 10_000 });
    await page.getByRole("heading", unreachable).waitFor({ timeout: 10_000 });
    if ((await page.evaluate(buildShown)) !== "newer") throw new Error("another page opened");
    const styled = await page.evaluate(`(() => {
      const sheet = document.querySelector('link[rel="stylesheet"]')?.sheet;
      try { return sheet.cssRules.length > 0; } catch { return false; }
    })()`);
    if (!styled) throw new Error("it opened without its stylesheet");
  });

  await step("Hearth not answering: the last page opens within a few seconds", async () => {
    // Not as the page that started, which opens at once anyway: as when it has to ask Hearth first.
    await page.evaluate(`caches.open("hearth-shell-v3").then((c) => c.delete("/.started"))`);
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
    await start(join(copies, "newer"));
    // Signed in here, so Hearth is drawn under the notice: it's back once that's gone.
    await page.getByRole("heading", unreachable).waitFor({ state: "detached", timeout: 40_000 });
    await home(page).waitFor();
    if (!(await page.evaluate("window.sameLoad === true"))) throw new Error("the page reloaded");
  });

  await step(
    "opened while Hearth restarts for an update, it moves on once Hearth is back",
    async () => {
      await stop();
      // Hearth's window asking you to connect it again (Login.tsx): the page tidies that from the
      // address once it's read, and the new build must read it too.
      await page.goto(`${base}/?connect=desktop`, { timeout: 10_000 });
      await page.getByRole("heading", unreachable).waitFor({ timeout: 10_000 });
      // The check it made on opening went unanswered; it's made again when Hearth answers.
      await start();
      await shows(running, 40_000);
      await page.getByText("If Hearth's window on this PC asked you").waitFor({ timeout: 10_000 });
      if (await page.getByText("Hearth was updated.").isVisible())
        throw new Error("it said so instead of moving on");
    },
  );
  console.log("Offline checks passed.");
} finally {
  await browser.close();
  await endSilence();
  await stop();
  rmSync(copies, { recursive: true, force: true });
}
