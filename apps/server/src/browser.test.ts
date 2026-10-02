import type { AddressInfo } from "node:net";
import { PRINCIPAL } from "@hearth/core";
import { createSession } from "@hearth/db";
import { type ServerType, serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApiToken } from "./auth/tokens.ts";
import { createTestServer, TEST_ORIGIN, type TestServer } from "./testing/server.ts";

type Msg = Record<string, unknown> & { type: string };

let t: TestServer;
let http: ServerType;
let base: string;

beforeEach(async () => {
  t = await createTestServer({ devAuth: true });
  http = serve({ fetch: t.server.app.fetch, hostname: "127.0.0.1", port: 0 });
  t.server.attach(http as never);
  await new Promise((r) => http.once("listening", r));
  base = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await t.destroy();
  (http as import("node:http").Server).closeAllConnections();
  await new Promise((r) => http.close(r));
});

/** A WebSocket that queues messages so a test can wait for the next one of a type. */
function socket(path: string, origin: string) {
  const ws = new WebSocket(`${base}${path}`, { origin });
  const inbox: Msg[] = [];
  const waiters: { type: string; resolve(m: Msg): void }[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as Msg;
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0]?.resolve(msg);
    else inbox.push(msg);
  });
  const next = (type: string) =>
    new Promise<Msg>((resolve, reject) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0] as Msg);
      waiters.push({ type, resolve });
      setTimeout(() => reject(new Error(`No ${type} message`)), 3000);
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
  return { ws, next, opened, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

/** A pretend Chrome extension that answers calls from a table and records them. */
async function fakeExtension(token: string, answers: Record<string, (p: Msg) => unknown>) {
  const ext = socket("/api/browser/bridge", "chrome-extension://hearth-test");
  const calls: Msg[] = [];
  await ext.opened;
  ext.send({ type: "hello", token, version: "0.1.0" });
  ext.ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as Msg;
    if (msg.type !== "call") return;
    calls.push(msg);
    const answer = answers[String(msg.method)];
    const params = msg.params as Msg;
    const key = msg.method === "cdp" ? String(params.method) : String(msg.method);
    const result = (answers[key] ?? answer)?.(params) ?? {};
    ext.send({ type: "result", id: msg.id, result });
  });
  return { ...ext, calls };
}

async function pair(): Promise<string> {
  const res = await t.browser("/api/browser/pair", { method: "POST" });
  return ((await res.json()) as { token: string }).token;
}

describe("the browser bridge", () => {
  it("accepts only a paired extension", async () => {
    const stranger = socket("/api/browser/bridge", "chrome-extension://other");
    await stranger.opened;
    stranger.send({ type: "hello", token: "guess", version: "1" });
    expect(await stranger.next("rejected")).toMatchObject({ type: "rejected" });

    const page = socket("/api/browser/bridge", "https://evil.example");
    await expect(page.opened).rejects.toThrow("HTTP 403");

    const ext = await fakeExtension(await pair(), {});
    expect(await ext.next("welcome")).toEqual({ type: "welcome" });
    const status = await (await t.browser("/api/browser/status")).json();
    expect(status).toMatchObject({ connected: true, paired: true, version: "0.1.0" });
  });

  it("lets Jarvis reach Chrome through the server, but not outside agents", async () => {
    const ext = await fakeExtension(await pair(), { "tabs.list": () => [{ tabId: 7 }] });
    await ext.next("welcome");
    const jarvis = await createSession(t.kernel.db, { principal: PRINCIPAL.jarvis, kind: "api" });
    const res = await t.api("/api/browser/rpc", jarvis, {
      method: "POST",
      json: { method: "tabs.list" },
    });
    expect(await res.json()).toEqual({ result: [{ tabId: 7 }] });

    const { token: mcp } = await createApiToken(t.kernel.db, "laptop");
    const denied = await t.api("/api/browser/rpc", mcp, {
      method: "POST",
      json: { method: "tabs.list" },
    });
    expect(denied.status).toBe(403);
  });

  it("says Chrome is offline when no extension is connected", async () => {
    const jarvis = await createSession(t.kernel.db, { principal: PRINCIPAL.jarvis, kind: "api" });
    const res = await t.api("/api/browser/rpc", jarvis, {
      method: "POST",
      json: { method: "tabs.list" },
    });
    expect(res.status).toBe(503);
  });

  it("streams a tab to the live view and sends your input back", async () => {
    const ext = await fakeExtension(await pair(), {
      "tabs.show": () => ({ shown: true }),
    });
    await ext.next("welcome");
    ext.send({
      type: "tabs",
      tabs: [
        {
          tabId: 3,
          windowId: 1,
          url: "https://a.example/",
          title: "A",
          active: true,
          handed: false,
          loading: false,
        },
      ],
    });

    await expect(socket("/api/browser/live", "https://evil.example").opened).rejects.toThrow(
      "HTTP 401",
    );
    const viewer = socket("/api/browser/live", TEST_ORIGIN);
    await viewer.opened;
    expect(await viewer.next("state")).toMatchObject({ connected: true });
    viewer.send({ type: "view", tabId: 3 });
    await new Promise((r) => setTimeout(r, 100));
    const started = ext.calls.map((c) =>
      c.method === "cdp" ? (c.params as Msg).method : c.method,
    );
    expect(started).toEqual([
      "tabs.show",
      "Emulation.setFocusEmulationEnabled",
      "Page.startScreencast",
    ]);

    ext.send({
      type: "event",
      tabId: 3,
      method: "Page.screencastFrame",
      params: { data: "SlBFRw==", sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } },
    });
    expect(await viewer.next("frame")).toMatchObject({ tabId: 3, data: "SlBFRw==", width: 800 });

    viewer.send({
      type: "mouse",
      kind: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });
    viewer.send({ type: "key", kind: "keyDown", key: "Enter", code: "Enter" });
    await new Promise((r) => setTimeout(r, 100));
    const input = ext.calls
      .filter((c) => String((c.params as Msg).method).startsWith("Input."))
      .map((c) => (c.params as Msg).params);
    expect(input).toEqual([
      { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 },
      expect.objectContaining({
        type: "keyDown",
        key: "Enter",
        text: "\r",
        windowsVirtualKeyCode: 13,
      }),
    ]);
  });
});
