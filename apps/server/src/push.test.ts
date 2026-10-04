import { event } from "@hearth/db";
import { jarvisCaller, type Kernel, systemCaller } from "@hearth/kernel";
import { max } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairDevice } from "./auth/devices.ts";
import { EventHub } from "./hub.ts";
import { type PushMessage, type PushSend, pushToAll, startPush } from "./push.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
let sent: { endpoint: string; message: PushMessage }[];
let gone: Set<string>;
const fake: PushSend = async (sub, message, vapid) => {
  expect(vapid.publicKey).toBeTruthy();
  if (gone.has(sub.endpoint)) return false;
  sent.push({ endpoint: sub.endpoint, message });
  return true;
};

beforeEach(async () => {
  sent = [];
  gone = new Set();
  t = await createTestServer({ devAuth: true }, { push: fake });
});
afterEach(() => t.destroy());

const PHONE = "https://web.push.apple.com/abc";
const subscribe = (endpoint: string, label = "iPhone") =>
  t.browser("/api/push", {
    method: "POST",
    json: { endpoint, keys: { p256dh: "BKey", auth: "secret" }, label },
  });

/** Lets the server see the events so far, the way LISTEN would. */
async function settle() {
  const [row] = await t.tdb.db.select({ seq: max(event.seq) }).from(event);
  const seq = row?.seq ?? 0;
  t.server.hub.publish(seq);
  await t.server.pushIdle();
}

/** A watcher of its own, as a fresh start of the server would make. */
async function watch(kernel: Kernel = t.kernel) {
  const hub = new EventHub(null);
  const watcher = startPush(kernel, hub, fake);
  await watcher.idle();
  return {
    stop: watcher.stop,
    async settle() {
      const [row] = await t.tdb.db.select({ seq: max(event.seq) }).from(event);
      hub.publish(row?.seq ?? 0);
      await watcher.idle();
    },
  };
}

describe("phone notifications", () => {
  it("keeps devices and sends the brief and approvals, not everything", async () => {
    t.server.start();
    await settle();
    expect((await subscribe(PHONE)).status).toBe(200);
    for (const bad of [
      "http://evil.example/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest",
      "https://push.apple.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
    ])
      expect((await subscribe(bad)).status).toBe(400);
    const list = (await (await t.browser("/api/push")).json()) as {
      publicKey: string;
      devices: { label: string }[];
    };
    expect(list.publicKey.length).toBeGreaterThan(40);
    expect(list.devices).toMatchObject([{ label: "iPhone" }]);

    await t.kernel.execute(
      "brief.publish",
      { markdown: "## Today\n- nothing", date: "2026-10-01" },
      jarvisCaller("system"),
    );
    await t.kernel.execute("task.create", { title: "Not worth a buzz" }, jarvisCaller("owner"));
    await settle();
    expect(sent.map((s) => s.message.title)).toEqual(["Your brief is ready"]);
    expect(sent[0]).toMatchObject({ endpoint: PHONE, message: { url: "/inbox" } });

    // A device that's gone is forgotten.
    gone.add(PHONE);
    expect(await (await t.browser("/api/push/test", { method: "POST" })).json()).toEqual({
      sent: 0,
    });
    expect(((await (await t.browser("/api/push")).json()) as { devices: [] }).devices).toEqual([]);
  });

  it("buzzes for an interrupt held overnight when it goes out in the morning", async () => {
    t.server.start();
    await settle();
    await subscribe(PHONE);
    t.clock.set("2026-10-02T03:00:00Z"); // 11 p.m.
    const res = await t.kernel.execute<{ id: string; delivered: boolean }>(
      "inbox.notify",
      { title: "The garage door is open", urgency: "interrupt" },
      systemCaller(),
    );
    expect(res).toMatchObject({ status: "ok", result: { delivered: false } });
    await settle();
    expect(sent).toEqual([]);
    t.clock.set("2026-10-02T12:00:30Z"); // 8 a.m.
    const id = res.status === "ok" ? res.result.id : "";
    await t.kernel.execute("inbox.deliver", { id }, systemCaller());
    await settle();
    expect(sent.map((s) => s.message.title)).toEqual(["The garage door is open"]);
  });

  it("after a restart, sends what came in while it was down, and nothing twice", async () => {
    await subscribe(PHONE);
    const before = await watch();
    await t.kernel.execute(
      "brief.publish",
      { markdown: "## Today", date: "2026-10-01" },
      jarvisCaller("system"),
    );
    await before.settle();
    expect(sent.map((s) => s.message.title)).toEqual(["Your brief is ready"]);
    before.stop();

    // Down for an update: one item comes in, another comes and is answered elsewhere.
    await t.kernel.execute(
      "inbox.notify",
      { title: "The garage door is open", urgency: "interrupt" },
      systemCaller(),
    );
    const done = await t.kernel.execute<{ id: string }>(
      "inbox.notify",
      { title: "Already dealt with", urgency: "interrupt" },
      systemCaller(),
    );
    if (done.status !== "ok") throw new Error("notify failed");
    await t.kernel.execute("inbox.mark", { ids: [done.result.id], state: "done" }, systemCaller());

    const after = await watch();
    expect(sent.map((s) => s.message.title)).toEqual([
      "Your brief is ready",
      "The garage door is open",
    ]);
    after.stop();
  });

  it("doesn't move on when a read fails, so the next try still sends it", async () => {
    await subscribe(PHONE);
    let failNext = false;
    const db = new Proxy(t.kernel.db, {
      get(target, prop, receiver) {
        if (prop === "select" && failNext) {
          failNext = false;
          throw new Error("Connection terminated unexpectedly");
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const flaky = { db, clock: t.kernel.clock } as unknown as Kernel;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const watcher = await watch(flaky);
    await t.kernel.execute(
      "brief.publish",
      { markdown: "## Today", date: "2026-10-01" },
      jarvisCaller("system"),
    );
    failNext = true;
    await watcher.settle();
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Connection terminated"));
    await watcher.settle();
    expect(sent.map((s) => s.message.title)).toEqual(["Your brief is ready"]);
    watcher.stop();
    warn.mockRestore();
  });

  it("sends to every device at once; one that never answers doesn't hold up the rest", async () => {
    const HANGS = "https://fcm.googleapis.com/fcm/send/hangs";
    await subscribe(HANGS, "Old tablet");
    await subscribe(PHONE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hanging: PushSend = (sub, message, vapid) =>
      sub.endpoint === HANGS ? new Promise(() => {}) : fake(sub, message, vapid);
    const message = { title: "Hi", body: "", url: "/inbox", tag: "x" };
    const started = Date.now();
    expect(await pushToAll(t.kernel, message, hanging, 50)).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sent.map((s) => s.endpoint)).toEqual([PHONE]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Old tablet: no answer"));
    // A slow device isn't a gone one: it's kept.
    const list = (await (await t.browser("/api/push")).json()) as { devices: unknown[] };
    expect(list.devices).toHaveLength(2);
    warn.mockRestore();
  });

  it("is off limits to the desktop app's code", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    expect((await t.api("/api/push", token)).status).toBe(403);
  });
});
