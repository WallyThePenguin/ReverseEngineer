// The link to Chrome holding up (D52): replaced and silent links, out-of-date or stray
// extensions, the link's log and health, and "Test Jarvis's Chrome".
import type { AddressInfo } from "node:net";
import { PRINCIPAL } from "@hearth/core";
import { createSession } from "@hearth/db";
import { getSetting, systemCaller } from "@hearth/kernel";
import { createTestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES, BRIDGE_PROTOCOL, OFFLINE_MESSAGE } from "@hearth/modules";
import { type ServerType, serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserBridge } from "./browser/bridge.ts";
import { watchBrowserHealth } from "./browser/health.ts";
import { selfUrl } from "./browser/routes.ts";
import { closeAll, listen } from "./listen.ts";
import { type FakeOptions, fakeExtension, type Msg, Refusal, socket } from "./testing/extension.ts";
import { createTestServer, TEST_ORIGIN, type TestServer } from "./testing/server.ts";

let t: TestServer | null = null;
let http: ServerType | null = null;
let base = "";
let token = "";

async function start(bridge?: BrowserBridge) {
  t = await createTestServer({ devAuth: true }, bridge ? { bridge } : {});
  http = serve({ fetch: t.server.app.fetch, hostname: "127.0.0.1", port: 0 });
  t.server.attach(http as never);
  await new Promise((r) => http?.once("listening", r));
  base = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const res = await t.browser("/api/browser/pair", { method: "POST" });
  token = ((await res.json()) as { token: string }).token;
  return t;
}

afterEach(async () => {
  await t?.destroy();
  if (http) {
    (http as import("node:http").Server).closeAllConnections();
    await new Promise((r) => http?.close(r));
  }
  t = null;
  http = null;
});

const chrome = (answers: Record<string, (p: Msg) => unknown> = {}, opts: FakeOptions = {}) =>
  fakeExtension(base, token, answers, opts);

const status = async () => (await (await t!.browser("/api/browser/status")).json()) as Msg;

async function asJarvis(method: string, params: Record<string, unknown> = {}) {
  const jarvis = await createSession(t!.kernel.db, { principal: PRINCIPAL.jarvis, kind: "api" });
  return t!.api("/api/browser/rpc", jarvis, { method: "POST", json: { method, params } });
}

async function until(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out");
}

describe("the link to Chrome", () => {
  it("fails a call still waiting when Chrome reconnects, instead of leaving it hanging", async () => {
    await start();
    // An extension that takes calls but never answers them.
    const first = socket(base, "/api/browser/bridge", "chrome-extension://x");
    await first.opened;
    first.send({ type: "hello", token, version: "0.3.0", protocol: BRIDGE_PROTOCOL });
    await first.next("welcome");
    const waiting = asJarvis("tabs.list");
    await first.next("call");

    const second = await chrome({ "tabs.list": () => [] });
    await second.next("welcome");
    const res = await waiting;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "Chrome reconnected before it answered. Try again.",
      code: "unavailable",
    });
    expect(await (await asJarvis("tabs.list")).json()).toEqual({ result: [] });
  });

  it("drops a link that stops answering pings, and keeps one that answers", async () => {
    await start(new BrowserBridge({ pingMs: 30 }));
    const quiet = await chrome({}, { pong: false });
    await quiet.next("welcome");
    await until(async () => (await status()).connected === false);
    const log = (await (await t!.browser("/api/browser/log")).json()) as { entries: Msg[] };
    expect(log.entries[0]).toMatchObject({ kind: "disconnect" });
    expect(String(log.entries[0]?.message)).toContain("stopped answering pings");

    const lively = await chrome();
    await lively.next("welcome");
    // A link that never answers still gets two pings, and one whose first answer is the only one
    // heard gets three: a sixth means it went on hearing them. Counting pings rather than waiting
    // a set time holds however slowly the timers run.
    for (let n = 0; n < 6; n++) await lively.next("ping");
    expect(await status()).toMatchObject({ connected: true });
  });

  it("asks an extension from before protocol 2 to update, and says it's out of date", async () => {
    await start();
    const old = await chrome({}, { protocol: null, version: "0.2.0" });
    expect(await old.next("welcome")).toEqual({ type: "welcome", protocol: BRIDGE_PROTOCOL });
    expect(await old.next("update")).toMatchObject({ type: "update" });
    const s = await status();
    expect(s).toMatchObject({ connected: true, protocol: 1 });
    expect(String(s.problem)).toContain("out of date");
  });

  it("notices an extension with a different ID", async () => {
    await start();
    const stray = await chrome({}, { id: "abcdefghijklmnopabcdefghijklmnop" });
    await stray.next("welcome");
    const s = await status();
    expect(s).toMatchObject({ extensionId: "abcdefghijklmnopabcdefghijklmnop" });
    expect(String(s.problem)).toContain("different ID");
  });

  it("keeps a log of the link and passes Chrome's reasons on", async () => {
    await start();
    const ext = await chrome({
      "Page.navigate": () => new Refusal("Hearth doesn't allow that.", "not_allowed"),
      "Input.dispatchMouseEvent": () => new Refusal("A confirm dialog is open.", "dialog_open"),
      "tabs.list": () => [],
    });
    await ext.next("welcome");
    const refused = await asJarvis("cdp", { tabId: 1, method: "Page.navigate", params: {} });
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({
      error: "Hearth doesn't allow that.",
      code: "forbidden",
      reason: "not_allowed",
    });
    const blocked = await asJarvis("cdp", { tabId: 1, method: "Input.dispatchMouseEvent" });
    expect(await blocked.json()).toMatchObject({ code: "conflict", reason: "dialog_open" });
    await asJarvis("tabs.list");

    const { entries, stats } = (await (await t!.browser("/api/browser/log")).json()) as {
      entries: Msg[];
      stats: Msg;
    };
    // A dialog in the way is part of the work, not a fault in the link.
    expect(entries.map((e) => e.kind)).toEqual(["error", "connect"]);
    expect(entries[0]).toMatchObject({ method: "cdp Page.navigate" });
    expect(typeof entries[0]?.ms).toBe("number");
    expect(stats).toMatchObject({ calls: 3, failed: 1 });
  });

  it("logs a turned-away extension", async () => {
    await start();
    const stranger = socket(base, "/api/browser/bridge", "chrome-extension://x");
    await stranger.opened;
    stranger.send({ type: "hello", token: "guess", protocol: BRIDGE_PROTOCOL });
    await stranger.next("rejected");
    const { entries } = (await (await t!.browser("/api/browser/log")).json()) as {
      entries: Msg[];
    };
    expect(entries[0]).toMatchObject({ kind: "reject" });
  });
});

describe("Chrome's health", () => {
  it("reports the browser component when the link changes", async () => {
    const tk = await createTestKernel(ALL_MODULES);
    try {
      const bridge = new BrowserBridge({ isPaired: async () => false });
      const stop = watchBrowserHealth(tk.kernel, bridge, { everyMs: 60_000, settleMs: 10 });
      const health = async () => {
        const res = await tk.kernel.execute<{ components: Record<string, Msg> }>(
          "system.status",
          {},
          systemCaller(),
        );
        return res.status === "ok" ? res.result.components.browser : undefined;
      };
      await until(async () => (await health()) !== undefined);
      expect(await health()).toMatchObject({ status: "ok" });
      expect(String((await health())?.detail)).toContain("No Chrome extension is paired");
      stop();
      bridge.close();
    } finally {
      await tk.destroy();
    }
  });
});

describe("Test Jarvis's Chrome", () => {
  it("serves its test page to anyone, under a tight policy", async () => {
    await start();
    const res = await t!.server.app.request("/api/browser/test-page");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Press me");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("is yours to run, as Jarvis, and says plainly when Chrome is offline", async () => {
    await start();
    const jarvis = await createSession(t!.kernel.db, { principal: PRINCIPAL.jarvis, kind: "api" });
    const denied = await t!.api("/api/browser/self-test", jarvis, { method: "POST" });
    expect(denied.status).toBe(403);

    const http = base.replace(/^ws/, "http");
    const res = await fetch(`${http}/api/browser/self-test`, {
      method: "POST",
      headers: { origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: false,
      steps: [
        { step: "tabs", ok: true },
        { step: "open", ok: false, detail: OFFLINE_MESSAGE },
      ],
    });
    expect(await getSetting(t!.kernel.db, "browser.pairing")).not.toBeNull();
  });

  it("sends Chrome to 127.0.0.1 whichever loopback you asked on", () => {
    const at = (localAddress: string) =>
      selfUrl({ incoming: { socket: { localAddress, localPort: 4400 } } });
    expect(at("::1")).toBe("http://127.0.0.1:4400");
    expect(at("::ffff:127.0.0.1")).toBe("http://127.0.0.1:4400");
    expect(at("127.0.0.1")).toBe("http://127.0.0.1:4400");
    expect(at("::")).toBe("http://127.0.0.1:4400");
    // Anything else is where it came in.
    expect(at("100.64.0.5")).toBe("http://100.64.0.5:4400");
    expect(selfUrl({})).toBeNull();
  });

  it("opens its test page on 127.0.0.1 when you ran it from localhost over [::1]", async () => {
    // Hearth on this PC, as main.ts starts it: on 127.0.0.1 and [::1].
    t = await createTestServer({ devAuth: true });
    const servers = await listen(t.server.app.fetch, "127.0.0.1", 0);
    t.server.attach(...servers);
    try {
      if (servers.length < 2) return; // No IPv6 on this machine: nothing to check.
      const port = (servers[0]!.address() as AddressInfo).port;
      base = `ws://127.0.0.1:${port}`;
      const paired = await t.browser("/api/browser/pair", { method: "POST" });
      token = ((await paired.json()) as { token: string }).token;
      const ext = await chrome({ "tabs.list": () => [] });
      await ext.next("welcome");

      const res = await fetch(`http://[::1]:${port}/api/browser/self-test`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN },
      });
      expect(res.status).toBe(200);
      const asked = JSON.stringify(ext.calls);
      expect(asked).toContain(`http://127.0.0.1:${port}/api/browser/test-page`);
      expect(asked).not.toContain("[::1]");
      ext.ws.close();
    } finally {
      for (const s of servers) s.closeAllConnections();
      await closeAll(servers);
    }
  });
});
