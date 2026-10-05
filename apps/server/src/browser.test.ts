import type { AddressInfo } from "node:net";
import { PRINCIPAL } from "@hearth/core";
import { createSession, session } from "@hearth/db";
import { BRIDGE_PROTOCOL, EXTENSION_ID } from "@hearth/modules";
import { type ServerType, serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "./auth/middleware.ts";
import { createApiToken, revokeToken } from "./auth/tokens.ts";
import {
  fakeExtension as fakeExtensionAt,
  type Msg,
  socket as socketTo,
} from "./testing/extension.ts";
import { createTestServer, TEST_ORIGIN, type TestServer } from "./testing/server.ts";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  await t.destroy();
  (http as import("node:http").Server).closeAllConnections();
  await new Promise((r) => http.close(r));
});

const socket = (path: string, origin: string, headers?: Record<string, string>) =>
  socketTo(base, path, origin, headers);
const fakeExtension = (token: string, answers: Record<string, (p: Msg) => unknown>) =>
  fakeExtensionAt(base, token, answers);

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
    expect(await ext.next("welcome")).toEqual({ type: "welcome", protocol: BRIDGE_PROTOCOL });
    const status = await (await t.browser("/api/browser/status")).json();
    expect(status).toMatchObject({
      connected: true,
      paired: true,
      version: "0.3.0",
      protocol: BRIDGE_PROTOCOL,
      extensionId: EXTENSION_ID,
      problem: null,
    });
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
    // Each call waits for Chrome's answer to the one before: wait for the last, not a set time.
    const started = () =>
      ext.calls.map((c) => (c.method === "cdp" ? (c.params as Msg).method : c.method));
    await vi.waitFor(() => expect(started()).toContain("Page.startScreencast"), {
      timeout: 10_000,
    });
    expect(started()).toEqual([
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
    const input = () =>
      ext.calls
        .filter((c) => String((c.params as Msg).method).startsWith("Input."))
        .map((c) => (c.params as Msg).params);
    await vi.waitFor(
      () => expect(input()).toContainEqual(expect.objectContaining({ type: "keyDown" })),
      { timeout: 10_000 },
    );
    expect(input()).toEqual([
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

describe("the live view", () => {
  it("closes when the sign-in it was opened with ends, and not before", async () => {
    const token = await createSession(t.kernel.db, {
      principal: PRINCIPAL.owner,
      kind: "browser",
      label: "test browser",
      ttlDays: 1,
    });
    const seen = async () =>
      (await t.kernel.db.select().from(session)).find((r) => r.label === "test browser");
    // Only the re-check's clock is pretend: the database and the socket run for real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const viewer = socket("/api/browser/live", TEST_ORIGIN, {
      cookie: `${SESSION_COOKIE}=${token}`,
    });
    const closed = new Promise<number>((resolve) => viewer.ws.once("close", resolve));
    await viewer.opened;
    await viewer.next("state");
    const settle = () => new Promise((r) => setTimeout(r, 200));

    // Still signed in: it stays open. Watching isn't using, so even a sign-in last used a while
    // ago isn't renewed by it (D56).
    const earlier = new Date(Date.now() - 10 * 60_000);
    await t.kernel.db
      .update(session)
      .set({ lastSeenAt: earlier })
      .where(eq(session.label, "test browser"));
    const before = await seen();
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(viewer.ws.readyState).toBe(viewer.ws.OPEN);
    expect(await seen()).toMatchObject({ lastSeenAt: earlier, expiresAt: before?.expiresAt });

    // The database being out of reach ends no one's session.
    vi.spyOn(t.kernel.db, "select").mockImplementation(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await vi.advanceTimersByTimeAsync(20_000);
    vi.mocked(t.kernel.db.select).mockRestore();
    await settle();
    expect(viewer.ws.readyState).toBe(viewer.ws.OPEN);

    // Signed out (in another tab, or by Disconnect): the next check closes it.
    await revokeToken(t.kernel.db, token);
    await vi.advanceTimersByTimeAsync(20_000);
    const open = new Promise((r) => setTimeout(() => r("still open"), 3000));
    expect(await Promise.race([closed, open])).toBe(4401);
  });

  it("drives nothing once it's closing, even for a client that won't let go", async () => {
    const ext = await fakeExtension(await pair(), { "tabs.show": () => ({ shown: true }) });
    await ext.next("welcome");
    const tab = { tabId: 3, windowId: 1, url: "https://a.example/", title: "A", active: true };
    ext.send({ type: "tabs", tabs: [{ ...tab, handed: false, loading: false }] });
    const token = await createSession(t.kernel.db, {
      principal: PRINCIPAL.owner,
      kind: "browser",
      label: "test browser",
      ttlDays: 1,
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const viewer = socket("/api/browser/live", TEST_ORIGIN, {
      cookie: `${SESSION_COOKIE}=${token}`,
    });
    await viewer.opened;
    await viewer.next("state");
    const settle = () => new Promise((r) => setTimeout(r, 200));
    const keys = () =>
      ext.calls.filter((c) => (c.params as Msg).method === "Input.dispatchKeyEvent").length;
    const enter = { type: "key", kind: "keyDown", key: "Enter", code: "Enter" };
    viewer.send({ type: "view", tabId: 3 });
    viewer.send(enter);
    // Not vi.waitFor: that would move the re-check's pretend clock as it waits.
    for (const end = Date.now() + 10_000; keys() === 0 && Date.now() < end; )
      await new Promise((r) => setTimeout(r, 20));
    expect(keys()).toBe(1);

    // A client of its own that never answers the close: ws waits 30 s for it before hanging up.
    const asked = new Promise<number | undefined>((resolve) => {
      viewer.ws.close = ((code?: number) => resolve(code)) as typeof viewer.ws.close;
    });
    await revokeToken(t.kernel.db, token);
    await vi.advanceTimersByTimeAsync(20_000);
    const open = new Promise((r) => setTimeout(() => r("still open"), 3000));
    expect(await Promise.race([asked, open])).toBe(4401);
    viewer.send(enter);
    await settle();
    expect(keys()).toBe(1);
  });
});
