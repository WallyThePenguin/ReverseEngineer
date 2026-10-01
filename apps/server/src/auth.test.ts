import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSetupCode } from "./auth/passkeys.ts";
import { SoftAuthenticator } from "./testing/authenticator.ts";
import { createTestServer, TEST_ORIGIN, type TestServer } from "./testing/server.ts";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.destroy());

type Options = { challenge: string };

async function registerFirstPasskey(passkey: SoftAuthenticator) {
  const code = await createSetupCode(t.kernel.db);
  const options = (await (
    await t.browser("/api/auth/register/options", { method: "POST", json: { setupCode: code } })
  ).json()) as Options;
  const res = await t.browser("/api/auth/register/verify", {
    method: "POST",
    json: { response: passkey.register(options), label: "Laptop", setupCode: code },
  });
  expect(res.status).toBe(200);
}

describe("passkey login", () => {
  it("starts in setup mode and refuses everything until you sign in", async () => {
    const me = await (await t.browser("/api/auth/me")).json();
    expect(me).toMatchObject({ signedIn: false, needsSetup: true });
    expect((await t.browser("/api/actions/task.list", { method: "POST", json: {} })).status).toBe(
      401,
    );
    expect(
      (await t.browser("/api/auth/register/options", { method: "POST", json: {} })).status,
    ).toBe(403);
    expect(
      (
        await t.browser("/api/auth/register/options", {
          method: "POST",
          json: { setupCode: "WRONG" },
        })
      ).status,
    ).toBe(403);
  });

  it("registers the first passkey with the setup code, then signs in with it", async () => {
    const passkey = new SoftAuthenticator(TEST_ORIGIN);
    await registerFirstPasskey(passkey);
    expect(await (await t.browser("/api/auth/me")).json()).toMatchObject({
      signedIn: true,
      kind: "owner",
      needsSetup: false,
    });

    // Signed out, nobody can add another passkey, even with an old setup code.
    await t.browser("/api/auth/logout", { method: "POST" });
    expect(await (await t.browser("/api/auth/me")).json()).toMatchObject({ signedIn: false });
    expect(
      (await t.browser("/api/auth/register/options", { method: "POST", json: {} })).status,
    ).toBe(403);

    const options = (await (
      await t.browser("/api/auth/login/options", { method: "POST" })
    ).json()) as Options;
    const login = await t.browser("/api/auth/login/verify", {
      method: "POST",
      json: { response: passkey.login(options) },
    });
    expect(login.status).toBe(200);
    const res = await t.browser("/api/actions/task.create", {
      method: "POST",
      json: { title: "Signed in" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a passkey it hasn't seen and a replayed challenge", async () => {
    await registerFirstPasskey(new SoftAuthenticator(TEST_ORIGIN));
    await t.browser("/api/auth/logout", { method: "POST" });
    const stranger = new SoftAuthenticator(TEST_ORIGIN);
    const options = (await (
      await t.browser("/api/auth/login/options", { method: "POST" })
    ).json()) as Options;
    const res = await t.browser("/api/auth/login/verify", {
      method: "POST",
      json: { response: stranger.login(options) },
    });
    expect(res.status).toBe(401);
    // The challenge was used up by that attempt.
    const again = await t.browser("/api/auth/login/verify", {
      method: "POST",
      json: { response: stranger.login(options) },
    });
    expect(again.status).toBe(400);
  });

  it("refuses cookie-authenticated writes from another site", async () => {
    await registerFirstPasskey(new SoftAuthenticator(TEST_ORIGIN));
    const res = await t.browser("/api/actions/task.create", {
      method: "POST",
      json: { title: "Sneaky" },
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});
