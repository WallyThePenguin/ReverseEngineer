import type { AddressInfo } from "node:net";
import { PRINCIPAL } from "@hearth/core";
import { createSession } from "@hearth/db";
import { ActionError, getSetting } from "@hearth/kernel";
import { type ServerType, serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserBridge } from "./browser/bridge.ts";
import type { ChromeLauncher } from "./browser/launch.ts";
import { CLOSED_AT_ONCE, NOT_PAIRED, OLD_CODE, type OpenTiming } from "./browser/opener.ts";
import { fakeExtension, type Msg, socket } from "./testing/extension.ts";
import { createTestServer, TEST_ORIGIN, type TestServer } from "./testing/server.ts";

let t: TestServer;
let http: ServerType;
let base: string;
let token: string;

const TAB = {
  tabId: 5,
  windowId: 1,
  url: "https://a.example/",
  title: "A",
  active: true,
  handed: false,
  loading: false,
};

/** A launcher that "starts Chrome": after a moment, a pretend extension connects. */
function fakeLauncher(opts: { connects?: boolean; error?: string; afterMs?: number } = {}) {
  const launcher = {
    opened: 0,
    hint: "Windows only opens it while you're signed in on the PC.",
    async open() {
      launcher.opened++;
      if (opts.error) throw new ActionError("unavailable", opts.error);
      if (opts.connects === false) return;
      setTimeout(() => void chrome(), opts.afterMs ?? 50);
    },
  };
  return launcher;
}

const chrome = () => fakeExtension(base, token, { "tabs.open": () => TAB });

async function start(launcher: ChromeLauncher, timing: Partial<OpenTiming> = {}) {
  const bridge = new BrowserBridge({
    launcher,
    isPaired: async () => (await getSetting(t.kernel.db, "browser.pairing")) !== null,
    timing: { startGraceMs: 0, dropGraceMs: 0, connectMs: 1000, retryMs: 60_000, ...timing },
  });
  t = await createTestServer({ devAuth: true }, { bridge });
  http = serve({ fetch: t.server.app.fetch, hostname: "127.0.0.1", port: 0 });
  t.server.attach(http as never);
  await new Promise((r) => http.once("listening", r));
  base = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const res = await t.browser("/api/browser/pair", { method: "POST" });
  token = ((await res.json()) as { token: string }).token;
  return bridge;
}

afterEach(async () => {
  await t.destroy();
  (http as import("node:http").Server).closeAllConnections();
  await new Promise((r) => http.close(r));
});

async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 20));
}

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const jarvis = await createSession(t.kernel.db, { principal: PRINCIPAL.jarvis, kind: "api" });
  const res = await t.api("/api/browser/rpc", jarvis, { method: "POST", json: { method, params } });
  return { status: res.status, body: (await res.json()) as { result?: unknown; error?: string } };
}

describe("opening Chrome when it's closed", () => {
  it("opens Chrome once when Jarvis opens pages, then carries on", async () => {
    const launcher = fakeLauncher();
    await start(launcher);
    const [a, b] = await Promise.all([
      rpc("tabs.open", { url: "https://a.example/" }),
      rpc("tabs.open", { url: "https://b.example/" }),
    ]);
    expect(a).toEqual({ status: 200, body: { result: TAB } });
    expect(b.status).toBe(200);
    expect(launcher.opened).toBe(1);
  });

  it("doesn't open Chrome just to list tabs or use a tab that's gone", async () => {
    const launcher = fakeLauncher();
    await start(launcher);
    expect((await rpc("tabs.list")).status).toBe(503);
    expect((await rpc("cdp", { tabId: 5, method: "Page.reload" })).status).toBe(503);
    expect(launcher.opened).toBe(0);
  });

  it("gives a running Chrome time to reconnect after Hearth restarts", async () => {
    const launcher = fakeLauncher();
    // The grace counts from Hearth starting, and making the test database can take seconds; a
    // connection ends the wait anyway.
    await start(launcher, { startGraceMs: 30_000 });
    setTimeout(() => void chrome(), 100);
    expect((await rpc("tabs.open", { url: "https://a.example/" })).status).toBe(200);
    expect(launcher.opened).toBe(0);
  });

  it("says why when Chrome doesn't connect, and doesn't keep trying by itself", async () => {
    const launcher = fakeLauncher({ connects: false });
    await start(launcher, { connectMs: 1500 });
    const first = await rpc("tabs.open", { url: "https://a.example/" });
    expect(first.status).toBe(503);
    expect(first.body.error).toBe(
      `Hearth started Chrome, but the Hearth extension didn't connect within 2 seconds. Windows only opens it while you're signed in on the PC. Check that the extension is installed and paired in that Chrome profile, and that Chrome's "Continue running background apps" setting is on.`,
    );
    // The worker's next page check fails at once instead of starting Chrome again.
    expect((await rpc("tabs.open", { url: "https://a.example/" })).body.error).toBe(
      first.body.error,
    );
    expect(launcher.opened).toBe(1);
    const status = await (await t.browser("/api/browser/status")).json();
    expect(status).toMatchObject({ connected: false, canOpen: true, openError: first.body.error });

    // You can still ask for it, and it tries again right away.
    expect((await t.browser("/api/browser/open", { method: "POST" })).status).toBe(503);
    expect(launcher.opened).toBe(2);
  });

  it("doesn't open Chrome before you've paired it", async () => {
    const launcher = fakeLauncher();
    await start(launcher);
    await t.browser("/api/browser/pair", { method: "DELETE" });
    const res = await rpc("tabs.open", { url: "https://a.example/" });
    expect(res).toEqual({ status: 503, body: { error: NOT_PAIRED, code: "unavailable" } });
    expect(launcher.opened).toBe(0);
  });

  /** A launcher whose Chrome knocks with `code`, and whose paired extension connects after `ms`. */
  function knocking(code: () => string, ms?: number) {
    return {
      hint: "",
      async open() {
        setTimeout(() => void fakeExtension(base, code(), {}), 20);
        if (ms !== undefined) setTimeout(() => void chrome(), ms);
      },
    };
  }

  /** Pairs again, so the code the test started with is an old one. */
  async function pairAgain() {
    const old = token;
    const res = await t.browser("/api/browser/pair", { method: "POST" });
    token = ((await res.json()) as { token: string }).token;
    return old;
  }

  it("says so soon when the extension has an old pairing code", async () => {
    let old = "";
    await start(
      knocking(() => old),
      { connectMs: 10_000, oldCodeMs: 300 },
    );
    old = await pairAgain();
    const began = Date.now();
    expect((await rpc("tabs.open", { url: "https://a.example/" })).body.error).toBe(OLD_CODE);
    expect(Date.now() - began).toBeLessThan(5000);
  });

  it("still waits for a paired extension after an old code knocks", async () => {
    let old = "";
    await start(
      knocking(() => old, 200),
      { connectMs: 10_000, oldCodeMs: 2000 },
    );
    old = await pairAgain();
    expect((await rpc("tabs.open", { url: "https://a.example/" })).body).toEqual({ result: TAB });
  });

  it("isn't put off by something knocking with a code that was never Hearth's", async () => {
    await start(
      knocking(() => "a-wrong-code", 800),
      { connectMs: 10_000, oldCodeMs: 100 },
    );
    expect((await rpc("tabs.open", { url: "https://a.example/" })).body).toEqual({ result: TAB });
  });

  it("leaves Chrome closed for a while when it closes right after opening", async () => {
    let ext: Awaited<ReturnType<typeof chrome>> | null = null;
    const launcher = {
      opened: 0,
      hint: "",
      async open() {
        launcher.opened++;
        ext = await chrome();
      },
    };
    await start(launcher);
    expect((await rpc("tabs.open", { url: "https://a.example/" })).status).toBe(200);
    // Background apps are off: Chrome quits once Jarvis's tab is done.
    (ext as unknown as { ws: { close(): void } }).ws.close();
    await until(async () => !(await t.server.bridge.status()).connected);
    expect((await rpc("tabs.open", { url: "https://a.example/" })).body.error).toBe(CLOSED_AT_ONCE);
    expect(launcher.opened).toBe(1);
  });

  it("stops waiting for Chrome when Hearth stops", async () => {
    await start(fakeLauncher({ connects: false }), { connectMs: 30_000 });
    const waiting = rpc("tabs.open", { url: "https://a.example/" });
    await until(async () => (await t.server.bridge.status()).opening === true);
    t.server.bridge.close();
    expect(await waiting).toEqual({
      status: 503,
      body: { error: "Hearth is stopping.", code: "unavailable" },
    });
  });

  it("passes on why Chrome couldn't be started", async () => {
    await start(fakeLauncher({ error: "Hearth can't find Chrome on this computer." }));
    const res = await rpc("tabs.open", { url: "https://a.example/" });
    expect(res).toEqual({
      status: 503,
      body: { error: "Hearth can't find Chrome on this computer.", code: "unavailable" },
    });
  });

  it("opens Chrome when you ask, without waiting, and shows it in the live view", async () => {
    const launcher = fakeLauncher();
    await start(launcher, { startGraceMs: 60_000 });
    const viewer = socket(base, "/api/browser/live", TEST_ORIGIN);
    await viewer.opened;
    expect(await viewer.next("state")).toMatchObject({
      connected: false,
      canOpen: true,
      opening: false,
    });
    // Only you can press Open Chrome; Jarvis opens it by opening a page.
    const jarvis = await createSession(t.kernel.db, { principal: PRINCIPAL.jarvis, kind: "api" });
    expect((await t.api("/api/browser/open", jarvis, { method: "POST" })).status).toBe(403);

    const res = await t.browser("/api/browser/open", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connected: true, opening: false, openError: null });
    expect(launcher.opened).toBe(1);
    const states: Msg[] = [];
    for (let i = 0; i < 3; i++) states.push(await viewer.next("state"));
    expect(states.map((s) => [s.opening, s.connected])).toContainEqual([true, false]);
    expect(states.at(-1)).toMatchObject({ connected: true, opening: false });
  });

  it("lets you skip the wait while Jarvis's try waits, and tells the pane when you unpair", async () => {
    const launcher = fakeLauncher();
    await start(launcher, { startGraceMs: 60_000 });
    const viewer = socket(base, "/api/browser/live", TEST_ORIGIN);
    await viewer.opened;
    expect(await viewer.next("state")).toMatchObject({ connected: false, paired: true });
    const waiting = rpc("tabs.open", { url: "https://a.example/" });
    await until(async () => t.server.bridge.snapshot().opening === true);
    expect(launcher.opened).toBe(0);
    expect((await t.browser("/api/browser/open", { method: "POST" })).status).toBe(200);
    expect((await waiting).body).toEqual({ result: TAB });
    expect(launcher.opened).toBe(1);

    await t.browser("/api/browser/pair", { method: "DELETE" });
    for (;;) if ((await viewer.next("state")).paired === false) break;
    expect((await rpc("tabs.open", { url: "https://a.example/" })).body.error).toBe(NOT_PAIRED);
  });
});
