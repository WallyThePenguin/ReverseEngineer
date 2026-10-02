// End-to-end check that Hearth opens Chrome by itself (D28): the server starts Chromium with the
// Hearth extension, in a profile paired beforehand. Jarvis's page opens in it, Chrome keeps running
// with no windows, and after Chrome quits, Jarvis opening a page starts it again. Linux only.
//
//   P=$(mktemp -d) E=$PWD/apps/extension
//   HEARTH_DEV_AUTH=1 HEARTH_CHROME_PATH=/path/to/chromium HEARTH_CHROME_ARGS="--headless=new \
//     --no-sandbox --user-data-dir=$P --disable-extensions-except=$E --load-extension=$E" \
//     hearth serve                                                 (in another terminal)
//   HEARTH_E2E_URL=http://localhost:4400 HEARTH_E2E_PROFILE=$P node apps/web/e2e/chrome-launch.ts
//
// HEARTH_E2E_CHROME points at the same Chromium, for pairing; otherwise Playwright's own is used.

import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.HEARTH_E2E_URL ?? "http://localhost:4400";
const profile = process.env.HEARTH_E2E_PROFILE;
if (!profile) throw new Error("Set HEARTH_E2E_PROFILE to the profile the server's Chrome uses.");
const extension = join(import.meta.dirname, "../../extension");

const site = createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end("<!doctype html><title>Opened by Hearth</title><h1>Hello</h1>");
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`Failed: ${what}`);
  console.log(`✓ ${what}`);
}

async function until<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A request to Hearth as you (development login). */
async function hearth<T>(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", origin: base },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function act<T>(name: string, input: unknown): Promise<T> {
  const res = await hearth<{ status: string; result: T }>(`/api/actions/${name}`, {
    method: "POST",
    json: input,
  });
  if (res.body.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res.body)}`);
  return res.body.result;
}

type Status = { connected: boolean; paired: boolean; canOpen: boolean; opening: boolean };
const status = async () => (await hearth<Status>("/api/browser/status")).body;

/** The browser process of a Chrome using the test profile, and its command line. */
function chromeProcess(): { pid: number; args: string[] } | null {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let args: string[];
    try {
      args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    const ours = args.includes(`--user-data-dir=${profile}`);
    if (ours && !args.some((a) => a.startsWith("--type="))) return { pid: Number(entry), args };
  }
  return null;
}

try {
  // Pair the extension in the profile the server's Chrome will use, then quit.
  const pairing = await chromium.launchPersistentContext(profile, {
    ...(process.env.HEARTH_E2E_CHROME
      ? { executablePath: process.env.HEARTH_E2E_CHROME }
      : { channel: "chromium" }),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = pairing.serviceWorkers()[0] ?? (await pairing.waitForEvent("serviceworker"));
  const { token } = (await hearth<{ token: string }>("/api/browser/pair", { method: "POST" })).body;
  const options = await pairing.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  await options.fill("#url", base);
  await options.fill("#token", token);
  await options.click("button[type=submit]");
  await until("the extension connects", async () => (await status()).connected);
  await pairing.close();
  await until("Chrome quits", async () => !(await status()).connected);
  check((await status()).canOpen, "Hearth says it can open Chrome");

  // Open Chrome, as from the button in Hearth.
  const opened = await hearth<Status>("/api/browser/open", { method: "POST" });
  check(
    opened.status === 200 && opened.body.connected,
    "Open Chrome starts Chrome and it connects",
  );
  const started = chromeProcess();
  check(started?.args.includes("--no-startup-window"), "it starts with no window of its own");

  const { tabId } = await act<{ tabId: number }>("browser.open", { url: siteUrl });
  const page = await act<{ title: string }>("browser.read", { tabId });
  check(page.title === "Opened by Hearth", "Jarvis's page opens in the Chrome Hearth started");

  await act("browser.close", { tabId });
  await new Promise((r) => setTimeout(r, 3000));
  check((await status()).connected, "Chrome keeps running with no windows open");

  // Quit Chrome. The next page Jarvis opens starts it again, after giving it a moment to return.
  if (started) process.kill(started.pid, "SIGTERM");
  await until("Chrome quits", async () => !(await status()).connected);
  const again = await act<{ tabId: number }>("browser.open", { url: siteUrl });
  check(again.tabId > 0 && chromeProcess(), "Jarvis opening a page starts Chrome again by itself");
  console.log("Chrome launch end-to-end check passed.");
} finally {
  const left = chromeProcess();
  if (left) process.kill(left.pid, "SIGTERM");
  site.close();
}
