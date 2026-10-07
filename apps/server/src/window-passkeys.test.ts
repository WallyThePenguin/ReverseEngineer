// The window on this PC signs in with a Windows Hello passkey of its own (D69): made and used only
// at http://localhost:<port>, only for requests straight from the app's page, only while the app
// is connected, and only as the window.
import { session } from "@hearth/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESKTOP_WINDOW, pairDevice, unpairDevice } from "./auth/devices.ts";
import { SESSION_COOKIE } from "./auth/middleware.ts";
import { createSetupCode } from "./auth/passkeys.ts";
import { windowRelyingParty } from "./auth/relying-party.ts";
import { SoftAuthenticator } from "./testing/authenticator.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

const TS_NET = "https://pc.example.ts.net";
const WINDOW = "http://localhost:4400";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const APP_UA = `${CHROME_UA} HearthDesktop/1.0.21`;

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ origin: TS_NET });
});
afterEach(() => t.destroy());

type Init = { method?: string; json?: unknown };
type Options = {
  challenge: string;
  rp?: { id: string };
  rpId?: string;
  allowCredentials?: { id: string }[];
  authenticatorSelection?: { userVerification?: string; authenticatorAttachment?: string };
};

/** A browser at Hearth's own address, through Tailscale Serve as it really comes. */
const browser = (path: string, init: Init = {}) =>
  t.browser(path, {
    ...init,
    from: "127.0.0.1",
    headers: { origin: TS_NET, host: "pc.example.ts.net", "x-forwarded-host": "pc.example.ts.net" },
  });
/** Hearth's window on this PC: the app's page, straight to Hearth's address here. */
const direct = { origin: WINDOW, host: "localhost:4400", "user-agent": APP_UA };
const window = (path: string, init: Init = {}) =>
  t.browser(path, { ...init, from: "127.0.0.1", headers: direct });

const options = async (res: Promise<Response>) => (await (await res).json()) as Options;
const me = async (via = window) =>
  (await (await via("/api/auth/me")).json()) as {
    signedIn: boolean;
    needsSetup: boolean;
    origin: string;
    localPasskey: boolean;
  };
const windowSessions = () =>
  t.kernel.db
    .select()
    .from(session)
    .where(and(eq(session.label, DESKTOP_WINDOW), isNull(session.revokedAt)));
/** The desktop app connected, as a hand-off pairs it. */
const connect = () => pairDevice(t.kernel.db, "desktop");

async function firstPasskey() {
  const passkey = new SoftAuthenticator(TS_NET);
  const code = await createSetupCode(t.kernel.db);
  const opts = await options(
    browser("/api/auth/register/options", { method: "POST", json: { setupCode: code } }),
  );
  const res = await browser("/api/auth/register/verify", {
    method: "POST",
    json: { response: passkey.register(opts), label: "Laptop", setupCode: code },
  });
  expect(res.status).toBe(200);
  return passkey;
}

/** Signed in, adds a passkey from the window: its own, unless it's refused. */
async function addFromWindow(hello: SoftAuthenticator) {
  const opts = await options(window("/api/auth/register/options", { method: "POST", json: {} }));
  expect(opts.rp?.id).toBe("localhost");
  return window("/api/auth/register/verify", {
    method: "POST",
    json: { response: hello.register(opts), label: "This PC's Hearth window" },
  });
}
async function windowPasskey() {
  const hello = new SoftAuthenticator(WINDOW);
  expect((await addFromWindow(hello)).status).toBe(200);
  return hello;
}

async function signInWindow(hello: SoftAuthenticator) {
  const opts = await options(window("/api/auth/login/options", { method: "POST" }));
  return window("/api/auth/login/verify", {
    method: "POST",
    json: { response: hello.login(opts) },
  });
}

describe("the window's own passkey", () => {
  it("is Windows Hello, made only once signed in, and listed with where it works", async () => {
    await firstPasskey();
    await connect();
    expect(await me()).toMatchObject({ signedIn: true, origin: TS_NET, localPasskey: false });

    const opts = await options(window("/api/auth/register/options", { method: "POST", json: {} }));
    expect(opts.authenticatorSelection).toMatchObject({
      authenticatorAttachment: "platform",
      userVerification: "required",
    });
    await windowPasskey();
    expect(await me()).toMatchObject({ localPasskey: true });

    const list = (await (await browser("/api/auth/passkeys")).json()) as {
      passkeys: { label: string; window: boolean }[];
    };
    expect(list.passkeys.map((p) => [p.label, p.window])).toEqual([
      ["Laptop", false],
      ["This PC's Hearth window", true],
    ]);
    t.cookies.clear();
    expect((await browser("/api/auth/passkeys")).status).toBe(401);
  });

  it("can't be the first passkey: not with the setup code, nor signed in by development login", async () => {
    const code = await createSetupCode(t.kernel.db);
    const res = await window("/api/auth/register/options", {
      method: "POST",
      json: { setupCode: code },
    });
    expect(res.status).toBe(403);

    await t.destroy();
    t = await createTestServer({ origin: TS_NET, devAuth: true });
    const dev = await window("/api/auth/register/options", { method: "POST", json: {} });
    expect(dev.status).toBe(403);
    expect(await me()).toMatchObject({ needsSetup: true });
  });

  it("must be this PC's own, not a passkey synced to other devices", async () => {
    await firstPasskey();
    await connect();
    const synced = new SoftAuthenticator(WINDOW, { synced: true });
    expect((await addFromWindow(synced)).status).toBe(400);
    expect(await me()).toMatchObject({ localPasskey: false });
    // At Hearth's own address a synced passkey is fine, as before.
    const phone = new SoftAuthenticator(TS_NET, { synced: true });
    const opts = await options(browser("/api/auth/register/options", { method: "POST", json: {} }));
    const res = await browser("/api/auth/register/verify", {
      method: "POST",
      json: { response: phone.register(opts), label: "Phone" },
    });
    expect(res.status).toBe(200);
  });

  it("signs in only as the window: one session, which Disconnect signs out", async () => {
    await firstPasskey();
    await connect();
    const hello = await windowPasskey();
    t.cookies.clear();

    // The window offers only its own passkey; Hearth's own address only the others.
    const opts = await options(window("/api/auth/login/options", { method: "POST" }));
    expect(opts.rpId).toBe("localhost");
    expect(opts.allowCredentials?.map((c) => c.id)).toEqual([
      Buffer.from(hello.credentialId).toString("base64url"),
    ]);
    const https = await options(browser("/api/auth/login/options", { method: "POST" }));
    expect(https.rpId).toBe("pc.example.ts.net");
    expect(https.allowCredentials?.map((c) => c.id)).not.toContain(opts.allowCredentials?.[0]?.id);

    expect((await signInWindow(hello)).status).toBe(200);
    const first = t.cookies.get(SESSION_COOKIE)!;
    expect(await windowSessions()).toHaveLength(1);

    // Signing in again replaces the window's session.
    t.cookies.clear();
    expect((await signInWindow(hello)).status).toBe(200);
    expect(await windowSessions()).toHaveLength(1);
    const second = t.cookies.get(SESSION_COOKIE)!;
    t.cookies.set(SESSION_COOKIE, first);
    expect((await me()).signedIn).toBe(false);

    t.cookies.set(SESSION_COOKIE, second);
    expect((await me()).signedIn).toBe(true);
    expect((await window("/api/devices/desktop", { method: "DELETE" })).status).toBe(200);
    expect(await me()).toMatchObject({ signedIn: false, localPasskey: false });
    expect(await windowSessions()).toHaveLength(0);
  });

  it("signs nothing in while the app is disconnected, until it's connected again", async () => {
    await firstPasskey();
    await connect();
    const hello = await windowPasskey();
    t.cookies.clear();
    // Asked while connected, answered after Disconnect (what Settings' button runs).
    const opts = await options(window("/api/auth/login/options", { method: "POST" }));
    await unpairDevice(t.kernel.db, "desktop");
    const late = await window("/api/auth/login/verify", {
      method: "POST",
      json: { response: hello.login(opts) },
    });
    expect(late.status).toBe(409);
    expect((await window("/api/auth/login/options", { method: "POST" })).status).toBe(409);
    expect(await windowSessions()).toHaveLength(0);

    await connect();
    expect((await signInWindow(hello)).status).toBe(200);
    expect(await windowSessions()).toHaveLength(1);
  });

  it("is answered only at the address its challenge was made for", async () => {
    const laptop = await firstPasskey();
    await connect();
    const hello = await windowPasskey();
    t.cookies.clear();

    // The window's challenge, answered at Hearth's own address.
    const local = await options(window("/api/auth/login/options", { method: "POST" }));
    const res = await browser("/api/auth/login/verify", {
      method: "POST",
      json: { response: hello.login(local) },
    });
    expect(res.status).toBe(401);

    // Hearth's own challenge, answered at the window, with either passkey.
    for (const passkey of [laptop, hello]) {
      const own = await options(browser("/api/auth/login/options", { method: "POST" }));
      const there = await window("/api/auth/login/verify", {
        method: "POST",
        json: { response: passkey.login(own) },
      });
      expect(there.status).toBe(401);
    }

    // The laptop's passkey with the window's challenge, at the window.
    const again = await options(window("/api/auth/login/options", { method: "POST" }));
    const laptopThere = await window("/api/auth/login/verify", {
      method: "POST",
      json: { response: laptop.login(again) },
    });
    expect(laptopThere.status).toBe(401);
    expect((await me()).signedIn).toBe(false);
    expect(await windowSessions()).toHaveLength(0);
  });
});

describe("which address a request is for", () => {
  const rpOf = async (headers: Record<string, string>, from?: string) => {
    const res = await t.browser("/api/auth/login/options", { method: "POST", from, headers });
    return ((await res.json()) as Options).rpId;
  };

  it("is the window's only for a direct request from the app's page", async () => {
    await firstPasskey();
    await connect();
    await windowPasskey();
    t.cookies.clear();
    expect(await rpOf(direct, "127.0.0.1")).toBe("localhost");
    expect(await rpOf(direct, "::ffff:127.0.0.1")).toBe("localhost");

    // Chrome or Edge at the same address: they share Windows Hello's passkeys, but signing in
    // there would sign the window out.
    expect(await rpOf({ ...direct, "user-agent": CHROME_UA }, "127.0.0.1")).toBe(
      "pc.example.ts.net",
    );
    // Through Tailscale Serve, which also connects from this PC: its Host and X-Forwarded-Host.
    const serve = { ...direct, host: "pc.example.ts.net", "x-forwarded-host": "pc.example.ts.net" };
    expect(await rpOf(serve, "127.0.0.1")).toBe("pc.example.ts.net");
    // Any proxy's header, even with this PC's Host.
    for (const h of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
      "forwarded",
      "x-real-ip",
      "tailscale-user-login",
      "tailscale-headers-info",
    ])
      expect(await rpOf({ ...direct, [h]: "x" }, "127.0.0.1")).toBe("pc.example.ts.net");
    // Not from this PC, or to another Host.
    expect(await rpOf(direct, "100.64.0.7")).toBe("pc.example.ts.net");
    expect(await rpOf(direct)).toBe("pc.example.ts.net");
    expect(await rpOf({ ...direct, host: "127.0.0.1:4400" }, "127.0.0.1")).toBe(
      "pc.example.ts.net",
    );
    // Another page on this PC is turned away before that.
    const other = await t.browser("/api/auth/login/options", {
      method: "POST",
      from: "127.0.0.1",
      headers: { ...direct, origin: "http://localhost:3000" },
    });
    expect(other.status).toBe(403);
  });

  it("has no window address when it's Hearth's own, or a number", () => {
    const base = { origin: TS_NET, port: 4400 };
    expect(windowRelyingParty(base)).toEqual({ origin: WINDOW, rpID: "localhost", local: true });
    expect(windowRelyingParty({ ...base, origin: WINDOW })).toBeNull();
    expect(windowRelyingParty({ ...base, localOrigin: "http://127.0.0.1:4400" })).toBeNull();
  });
});
