// Hearth on the PC (D53): the sign-in hand-off and Hearth's address on this PC. The notification
// feed the desktop app shows is in desktop-notify.test.ts.
import { PRINCIPAL } from "@hearth/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairDevice, unpairDevice } from "./auth/devices.ts";
import { Handoffs } from "./auth/handoff.ts";
import { SESSION_COOKIE } from "./auth/middleware.ts";
import { createSession } from "./auth/tokens.ts";
import { loadServerConfig, type ServerConfig } from "./config.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

const TS_NET = "https://pc.example.ts.net";

let t: TestServer;
let running: TestServer | null = null;
afterEach(async () => {
  vi.useRealTimers();
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

    // The window trades the code for an ordinary session and lands on Today.
    const res = await fromApp(`/api/auth/desktop/window?code=${code}`, {
      headers: { host: "localhost:4400", "user-agent": "Mozilla/5.0 HearthDesktop/1.0.7" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/today");
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
    expect(await again.text()).toContain("Connect Nook on this PC");
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

  it("keeps one window session, and signs it out when the app is disconnected", async () => {
    await serve();
    await signInBrowser();
    const openWindow = async () => {
      const { token, code } = await connect();
      const cookie = sessionCookie(await fromApp(`/api/auth/desktop/window?code=${code}`))!;
      return { token, cookie: cookie.split(";")[0]! };
    };
    const signedIn = async (cookie?: string) => {
      const res = cookie
        ? await fromApp("/api/auth/me", { headers: { cookie } })
        : await t.browser("/api/auth/me");
      return ((await res.json()) as { signedIn: boolean }).signedIn;
    };
    const status = (token: string) =>
      t.api("/api/actions/system.status", token, { method: "POST", json: {} });

    const first = await openWindow();
    const second = await openWindow();
    // Connecting again replaces both the app's token and its window's session.
    expect((await status(first.token)).status).toBe(401);
    expect(await signedIn(first.cookie)).toBe(false);
    expect(await signedIn(second.cookie)).toBe(true);

    // Disconnecting it in Settings signs both out; the browser you did it in stays signed in.
    expect((await t.browser("/api/devices/desktop", { method: "DELETE" })).status).toBe(200);
    expect((await status(second.token)).status).toBe(401);
    expect(await signedIn(second.cookie)).toBe(false);
    expect(await signedIn()).toBe(true);
  });

  it("keeps the window signed in when the app is paired again, not when it's unpaired", async () => {
    await serve();
    await signInBrowser();
    const { code } = await connect();
    const opened = await fromApp(`/api/auth/desktop/window?code=${code}`);
    const cookie = sessionCookie(opened)!.split(";")[0]!;
    const signedIn = async () => {
      const res = await fromApp("/api/auth/me", { headers: { cookie } });
      return ((await res.json()) as { signedIn: boolean }).signedIn;
    };
    // `hearth device pair desktop` replaces the app's token only.
    await pairDevice(t.kernel.db, "desktop");
    expect(await signedIn()).toBe(true);
    // Unpairing, from Settings or `hearth device unpair desktop`, signs both out.
    expect(await unpairDevice(t.kernel.db, "desktop")).toBe(2);
    expect(await signedIn()).toBe(false);
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

  it("keeps it that way when a sign-in slides and its cookie is sent again", async () => {
    await serve();
    await signInBrowser();
    const { code } = await connect();
    const res = await fromApp(`/api/auth/desktop/window?code=${code}`, {
      headers: { host: "localhost:4400" },
    });
    const cookie = sessionCookie(res)!.split(";")[0]!;
    // Used a while later, the sign-in slides and the cookie comes again (D56).
    const later = Date.now() + 10 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    const renewed = async (host: string, at: number) => {
      vi.setSystemTime(at);
      return sessionCookie(await fromApp("/api/auth/me", { headers: { host, cookie } }));
    };
    const here = await renewed("localhost:4400", later);
    expect(here).toBeDefined();
    expect(here).not.toMatch(/;\s*Secure/i);
    expect(await renewed("pc.example.ts.net", later + 10 * 60_000)).toMatch(/;\s*Secure/i);
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
