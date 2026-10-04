// Hearth on the PC (D53): the sign-in hand-off, Hearth's address on this PC, and the
// notification feed the desktop app shows.
import { PRINCIPAL } from "@hearth/core";
import { jarvisCaller, latestSeq, readEventsAfter, systemCaller } from "@hearth/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairDevice } from "./auth/devices.ts";
import { Handoffs } from "./auth/handoff.ts";
import { SESSION_COOKIE } from "./auth/middleware.ts";
import { createSession } from "./auth/tokens.ts";
import { loadServerConfig, type ServerConfig } from "./config.ts";
import { healthMessage, messagesFor } from "./routes/desktop.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

const TS_NET = "https://pc.example.ts.net";

let t: TestServer;
let running: TestServer | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await running?.destroy();
  running = null;
});

async function serve(config: Partial<ServerConfig> = {}) {
  t = await createTestServer({ origin: TS_NET, ...config });
  running = t;
}

/** Signs the test browser in, as you'd be after a passkey. */
async function signInBrowser() {
  const token = await createSession(t.kernel.db, {
    principal: PRINCIPAL.owner,
    kind: "browser",
    label: "test browser",
    ttlDays: 1,
  });
  t.cookies.set(SESSION_COOKIE, token);
}

/** What the desktop app sends: no cookie, no Origin. */
const fromApp = (path: string, init: RequestInit = {}) => t.server.app.request(path, init);

const redeem = (nonce: string) =>
  fromApp("/api/auth/desktop/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });

async function startHandoff(): Promise<string> {
  const res = await t.browser("/api/auth/desktop/handoff", { method: "POST" });
  expect(res.status).toBe(200);
  const { nonce, link } = (await res.json()) as { nonce: string; link: string };
  expect(link).toBe(`hearth://connect?nonce=${nonce}`);
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  return nonce;
}

async function connect() {
  const res = await redeem(await startHandoff());
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; code: string };
}

const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));

describe("connecting the desktop app", () => {
  it("hands a signed-in browser's sign-in to the app's window", async () => {
    await serve();
    await signInBrowser();
    const { token, code } = await connect();

    // The app's token is the desktop one, with today's scopes.
    const status = await t.api("/api/actions/system.status", token, { method: "POST", json: {} });
    expect(status.status).toBe(200);
    expect(
      (await t.api("/api/actions/task.list", token, { method: "POST", json: {} })).status,
    ).toBe(403);

    // The window trades the code for an ordinary session and lands in the inbox.
    const res = await fromApp(`/api/auth/desktop/window?code=${code}`, {
      headers: { host: "localhost:4400", "user-agent": "Mozilla/5.0 HearthDesktop/1.0.7" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/inbox");
    const cookie = sessionCookie(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const me = await fromApp("/api/auth/me", { headers: { cookie: cookie.split(";")[0]! } });
    expect(await me.json()).toMatchObject({ signedIn: true, kind: "owner" });
  });

  it("uses each nonce and code once", async () => {
    await serve();
    await signInBrowser();
    const nonce = await startHandoff();
    expect((await redeem(nonce)).status).toBe(200);
    expect((await redeem(nonce)).status).toBe(410);
    expect((await redeem("x".repeat(43))).status).toBe(410);
    expect((await redeem("short")).status).toBe(410);

    const { code } = await connect();
    expect((await fromApp(`/api/auth/desktop/window?code=${code}`)).status).toBe(302);
    const again = await fromApp(`/api/auth/desktop/window?code=${code}`);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("Connect Hearth on this PC");
    expect(sessionCookie(again)).toBeUndefined();
  });

  it("lets nonces and codes run out after a minute", async () => {
    await serve();
    await signInBrowser();
    const nonce = await startHandoff();
    const { code } = await connect();
    const later = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await redeem(nonce)).status).toBe(410);
    expect((await fromApp(`/api/auth/desktop/window?code=${code}`)).status).toBe(410);
  });

  it("only a signed-in browser can start one: never a device's token", async () => {
    await serve();
    const token = await pairDevice(t.kernel.db, "desktop");
    expect((await t.api("/api/auth/desktop/handoff", token, { method: "POST" })).status).toBe(403);
    // Nor anyone signed out, nor the app itself.
    expect((await t.browser("/api/auth/desktop/handoff", { method: "POST" })).status).toBe(403);
    expect((await fromApp("/api/auth/desktop/handoff", { method: "POST" })).status).toBe(403);
    // And the device's token can't approve anything.
    const decide = await t.api("/api/approvals/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", token, {
      method: "POST",
      json: { decision: "approve" },
    });
    expect(decide.status).toBe(403);
  });

  it("forgets nonces after a minute, by the clock it's given", () => {
    let now = 1_000_000;
    const h = new Handoffs(() => now);
    const a = h.nonces.issue("owner");
    const b = h.nonces.issue("owner");
    expect(h.nonces.take(a)).toBe("owner");
    expect(h.nonces.take(a)).toBeNull();
    now += 60_001;
    expect(h.nonces.take(b)).toBeNull();
    expect(h.codes.take(a)).toBeNull();
    expect(h.nonces.take(undefined)).toBeNull();
  });
});

describe("Hearth's address on this PC", () => {
  it("reads HEARTH_LOCAL_ORIGIN, and only takes one on this PC", () => {
    const env = { HEARTH_CHROME_LAUNCH: "off", HEARTH_PORT: "4400" };
    expect(loadServerConfig(env).localOrigin).toBeUndefined();
    expect(
      loadServerConfig({ ...env, HEARTH_LOCAL_ORIGIN: "http://127.0.0.1:4400/" }).localOrigin,
    ).toBe("http://127.0.0.1:4400");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      loadServerConfig({ ...env, HEARTH_LOCAL_ORIGIN: "https://evil.example" }).localOrigin,
    ).toBeUndefined();
  });

  it("takes writes from Hearth's own pages at either address, and no other", async () => {
    await serve({ localOrigin: "http://127.0.0.1:4400" });
    await signInBrowser();
    const write = (origin: string) =>
      t.browser("/api/auth/desktop/handoff", { method: "POST", headers: { origin } });
    expect((await write(TS_NET)).status).toBe(200);
    expect((await write("http://127.0.0.1:4400")).status).toBe(200);
    expect((await write("http://localhost:4400")).status).toBe(403);
    expect((await write("http://127.0.0.1:9999")).status).toBe(403);
  });

  it("makes the session cookie Secure except on the plain-http address here", async () => {
    await serve();
    await signInBrowser();
    const open = async (host: string) => {
      const { code } = await connect();
      return sessionCookie(
        await fromApp(`/api/auth/desktop/window?code=${code}`, { headers: { host } }),
      )!;
    };
    expect(await open("localhost:4400")).not.toMatch(/;\s*Secure/i);
    expect(await open("pc.example.ts.net")).toMatch(/;\s*Secure/i);
  });

  it("never makes it Secure when Hearth itself is on plain http", async () => {
    await serve({ origin: "http://localhost:4400" });
    await signInBrowser();
    const { code } = await connect();
    const res = await fromApp(`/api/auth/desktop/window?code=${code}`, {
      headers: { host: "pc.example.ts.net" },
    });
    expect(sessionCookie(res)).not.toMatch(/;\s*Secure/i);
  });
});

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
