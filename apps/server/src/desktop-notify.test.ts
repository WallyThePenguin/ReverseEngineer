// Hearth on the PC (D53): the notification feed the desktop app shows as Windows notifications.
import { jarvisCaller, latestSeq, readEventsAfter, systemCaller } from "@hearth/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { pairDevice, revokeDevice } from "./auth/devices.ts";
import { PUSH_KINDS } from "./push.ts";
import { healthMessage, messagesFor, stillSignedIn } from "./routes/desktop.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
let running: TestServer | null = null;
afterEach(async () => {
  await running?.destroy();
  running = null;
});

async function serve() {
  t = await createTestServer({ origin: "https://pc.example.ts.net" });
  running = t;
}

/** What the desktop app sends: no cookie, no Origin. */
const fromApp = (path: string, init: RequestInit = {}) => t.server.app.request(path, init);

/** Reads a server-sent event stream as it arrives. */
function sse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    /** Everything so far, once `marker` has arrived. */
    async until(marker: string) {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text;
    },
    stop: () => reader.cancel(),
  };
}

const notes = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith('data: {"title"'))
    .map((l) => JSON.parse(l.slice("data: ".length)) as { title: string; url: string });

const publishBrief = () =>
  t.kernel.execute(
    "brief.publish",
    { markdown: "## Today\n- nothing", date: "2026-10-01" },
    jarvisCaller("system"),
  );

describe("the desktop notification feed", () => {
  it("sends the desktop app what's worth a notification, and nothing else", async () => {
    await serve();
    const token = await pairDevice(t.kernel.db, "desktop");
    const res = await t.api("/api/desktop/notify", token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const feed = sse(res.body!);
    await feed.until("event: ready");

    await t.kernel.execute("task.create", { title: "Not worth a buzz" }, jarvisCaller("owner"));
    await publishBrief();
    t.server.hub.publish(await latestSeq(t.kernel.db));
    const text = await feed.until("event: notify");
    await feed.stop();
    expect(notes(text)).toMatchObject([{ title: "Your brief is ready", url: "/inbox" }]);
    expect(text).not.toContain("Not worth a buzz");
  });

  it("tells you about an interrupt held overnight when it goes out in the morning", async () => {
    await serve();
    const token = await pairDevice(t.kernel.db, "desktop");
    const feed = sse((await t.api("/api/desktop/notify", token)).body!);
    await feed.until("event: ready");
    const before = await latestSeq(t.kernel.db);

    t.clock.set("2026-10-02T03:00:00Z"); // 11 p.m.: held for quiet hours
    const held = await t.kernel.execute<{ id: string; delivered: boolean }>(
      "inbox.notify",
      { title: "The garage door is open", urgency: "interrupt" },
      systemCaller(),
    );
    expect(held).toMatchObject({ status: "ok", result: { delivered: false } });
    t.server.hub.publish(await latestSeq(t.kernel.db));
    t.clock.set("2026-10-02T12:00:30Z"); // 8 a.m.
    const id = held.status === "ok" ? held.result.id : "";
    await t.kernel.execute("inbox.deliver", { id }, systemCaller());
    // Then something that always notifies, so the feed has a last word to wait for.
    await publishBrief();
    t.server.hub.publish(await latestSeq(t.kernel.db));
    const text = await feed.until("Your brief is ready");
    await feed.stop();
    const titles = ["The garage door is open", "Your brief is ready"];
    expect(notes(text).map((n) => n.title)).toEqual(titles);

    // Held only briefly, a reconnect can replay both of its events: still one notification.
    const now = t.kernel.clock.now();
    const events = await readEventsAfter(t.kernel.db, before, { kinds: PUSH_KINDS });
    const replay = events.map((e) => ({ ...e, at: now }));
    expect(replay.map((e) => e.kind)).toContain("notification.created");
    const replayed = await messagesFor(t.kernel.db, replay, now.getTime());
    expect(replayed.map((m) => m.message.title)).toEqual(titles);
  });

  it("catches up after a reconnect", async () => {
    await serve();
    const token = await pairDevice(t.kernel.db, "desktop");
    const before = await latestSeq(t.kernel.db);
    await publishBrief();
    const res = await t.api("/api/desktop/notify", token, {
      headers: { "last-event-id": `${before}` },
    });
    const feed = sse(res.body!);
    const text = await feed.until("event: notify");
    await feed.stop();
    expect(notes(text)).toMatchObject([{ title: "Your brief is ready" }]);
  });

  it("ends when the app is disconnected, rather than keep telling it things", async () => {
    await serve();
    const token = await pairDevice(t.kernel.db, "desktop");
    const feed = sse((await t.api("/api/desktop/notify", token)).body!);
    await feed.until("event: ready");
    expect(await stillSignedIn(t.kernel.db, token)).toBe(true);

    await revokeDevice(t.kernel.db, "desktop");
    expect(await stillSignedIn(t.kernel.db, token)).toBe(false);
    await publishBrief();
    t.server.hub.publish(await latestSeq(t.kernel.db));
    // The stream closes instead of sending the brief.
    expect(await feed.until("event: notify")).not.toContain("event: notify");
  });

  it("is only for you and your devices, and isn't the whole event feed", async () => {
    await serve();
    expect((await fromApp("/api/desktop/notify")).status).toBe(401);
    const token = await pairDevice(t.kernel.db, "desktop");
    expect((await t.api("/api/events", token)).status).toBe(403);
  });

  it("tells you when something starts or stops failing, and leaves old news out", async () => {
    await serve();
    const before = await latestSeq(t.kernel.db);
    await publishBrief();
    const report = (status: string) =>
      t.kernel.execute(
        "system.report",
        { component: "jarvis", status, detail: "x" },
        systemCaller(),
      );
    await report("failing");
    await report("ok");
    await report("ok");
    const events = await readEventsAfter(t.kernel.db, before, {
      kinds: ["notification.created", "system.health_changed"],
    });
    const now = t.kernel.clock.now().getTime();
    const titles = (await messagesFor(t.kernel.db, events, now)).map((m) => m.message.title);
    expect(titles).toEqual([
      "Your brief is ready",
      "Jarvis isn't working",
      "Jarvis: working again",
    ]);
    expect(await messagesFor(t.kernel.db, events, now + 11 * 60_000)).toEqual([]);
    expect(
      healthMessage({ component: "disk", status: "degraded", previous: "ok" }, 1),
    ).toMatchObject({
      title: "Disk space needs a look",
      url: "/settings",
    });
    expect(healthMessage({ component: "disk", status: "ok", previous: null }, 2)).toBeNull();
  });
});
