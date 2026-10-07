// Hearth as passkey tests reach it: at its own address through Tailscale Serve, and from the
// desktop app's window on this PC (D69). Over whichever test server the test is on.
import { session } from "@hearth/db";
import { and, eq, isNull } from "drizzle-orm";
import { expect } from "vitest";
import { DESKTOP_WINDOW, pairDevice } from "../auth/devices.ts";
import { createSetupCode } from "../auth/passkeys.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import type { TestServer } from "./server.ts";

export const TS_NET = "https://pc.example.ts.net";
export const WINDOW = "http://localhost:4400";
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const APP_UA = `${CHROME_UA} HearthDesktop/1.0.21`;

/** The headers of a request from the app's page, straight to Hearth's address on this PC. */
export const direct = { origin: WINDOW, host: "localhost:4400", "user-agent": APP_UA };

type Init = { method?: string; json?: unknown };
export type Options = {
  challenge: string;
  rp?: { id: string };
  rpId?: string;
  allowCredentials?: { id: string }[];
  authenticatorSelection?: { userVerification?: string; authenticatorAttachment?: string };
};

export function passkeyRig(server: () => TestServer) {
  /** A browser at Hearth's own address, through Tailscale Serve as it really comes. */
  const browser = (path: string, init: Init = {}) =>
    server().browser(path, {
      ...init,
      from: "127.0.0.1",
      headers: {
        origin: TS_NET,
        host: "pc.example.ts.net",
        "x-forwarded-host": "pc.example.ts.net",
      },
    });
  /** Hearth's window on this PC: the app's page, straight to Hearth's address here. */
  const window = (path: string, init: Init = {}) =>
    server().browser(path, { ...init, from: "127.0.0.1", headers: direct });

  const options = async (res: Promise<Response>) => (await (await res).json()) as Options;
  const me = async (via = window) =>
    (await (await via("/api/auth/me")).json()) as {
      signedIn: boolean;
      needsSetup: boolean;
      origin: string;
      localPasskey: boolean;
    };
  const windowSessions = () =>
    server()
      .kernel.db.select()
      .from(session)
      .where(and(eq(session.label, DESKTOP_WINDOW), isNull(session.revokedAt)));
  /** The desktop app connected, as a hand-off pairs it. */
  const connect = () => pairDevice(server().kernel.db, "desktop");

  async function firstPasskey() {
    const passkey = new SoftAuthenticator(TS_NET);
    const code = await createSetupCode(server().kernel.db);
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

  return {
    browser,
    window,
    options,
    me,
    windowSessions,
    connect,
    firstPasskey,
    addFromWindow,
    windowPasskey,
    signInWindow,
  };
}
