import { randomBytes } from "node:crypto";
import { audit, event, vaultLogin } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { ChromiumBrowser, chromiumPath } from "./chromium.ts";
import { BROWSER_SERVICE } from "./client.ts";
import { pacing } from "./pace.ts";
import { loadTiming } from "./page.ts";
import { siteOf, VAULT_SERVICE, Vault } from "./vault.ts";

// Signing in from the vault, against real sign-in pages in Chromium.
const PASSWORD = "correct horse battery staple";
const welcome = "<title>Home</title><p>Welcome back</p>";
const PAGES: Record<string, string> = {
  // One page: name and password together.
  "https://login.example/": `<title>Sign in</title>
    <form method="post" action="/session">
      <input type="email" name="email" autocomplete="username" aria-label="Email">
      <input type="password" name="password" aria-label="Password">
      <button>Sign in</button>
    </form>`,
  "https://login.example/session": welcome,
  // Two pages: the name first, then the password.
  "https://steps.example/": `<title>Sign in</title>
    <form method="post" action="/password"><input name="identifier" autocomplete="username"
    aria-label="Email or phone">
    <button>Next</button></form>`,
  "https://steps.example/password": `<title>Password</title>
    <form method="post" action="/code"><input type="password" name="pw" aria-label="Password">
    <button>Next</button></form>`,
  // After the password, a code from your phone.
  "https://steps.example/code": `<title>2-Step</title>
    <form method="post"><input name="totp" autocomplete="one-time-code" aria-label="Code"></form>`,
  // On login.example's domain, but not login.example: a blog anyone there could post to.
  "https://blog.login.example/": `<form method="post" action="/grab">
    <input type="email" name="email" autocomplete="username"><input type="password" name="password"></form>`,
  // Looks like login.example, isn't.
  "https://login.example.evil.test/": `<form method="post" action="/grab">
    <input type="email" name="email"><input type="password" name="password"></form>`,
};

const hasChromium = chromiumPath() !== null;
let t: TestKernel;
let chrome: ChromiumBrowser;
const jarvis = jarvisCaller("agent");
const untrusted = jarvisCaller("untrusted");

beforeAll(async () => {
  if (hasChromium) chrome = await ChromiumBrowser.launch(PAGES);
});
afterAll(async () => {
  await chrome?.close();
});
beforeEach(async () => {
  Object.assign(loadTiming, { startMs: 250, pollMs: 50, settleMs: 50 });
  pacing.enabled = false;
  t = await createTestKernel(ALL_MODULES);
  t.kernel.services[BROWSER_SERVICE] = chrome;
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(async () => {
  await t.destroy();
});

async function ok<T>(name: string, input: unknown, caller: Caller = jarvis): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

const save = (site: string, username: string) =>
  ok("vault.save", { site, username, password: PASSWORD }, ownerCaller());

async function signIn(url: string, caller: Caller = jarvis) {
  const { tabId } = await ok<{ tabId: number }>("browser.open", { url });
  return t.kernel.execute("browser.sign_in", { tabId }, caller);
}

describe("the vault", () => {
  it("keeps passwords encrypted, tied to their site, and out of every log", async () => {
    await save("https://Login.Example/signin", "me@example.com");
    const [row] = await t.tdb.db.select().from(vaultLogin);
    expect(row).toMatchObject({ site: "login.example", username: "me@example.com" });
    expect(row?.secret).not.toContain(PASSWORD);
    const vault = t.kernel.services[VAULT_SERVICE] as Vault;
    expect(vault.open("login.example", "me@example.com", row!.secret)).toBe(PASSWORD);
    expect(() => vault.open("evil.test", "me@example.com", row!.secret)).toThrow(/can't be opened/);
    const logs = JSON.stringify([
      await t.tdb.db.select().from(audit),
      await t.tdb.db.select().from(event),
      await ok("vault.logins", {}),
    ]);
    expect(logs).not.toContain(PASSWORD);
  });

  it("is only the owner's to fill", async () => {
    const res = await t.kernel.execute(
      "vault.save",
      { site: "login.example", username: "x", password: "y" },
      jarvis,
    );
    expect(res.status).toBe("denied");
    expect(siteOf("not a site")).toBeNull();
  });
});

describe.skipIf(!hasChromium)("signing in", () => {
  it("signs in without asking, even mid-way through outside content", async () => {
    await save("login.example", "me@example.com");
    const res = await signIn("https://login.example/", untrusted);
    expect(res).toMatchObject({ status: "ok", result: { status: "signed_in" } });
    expect(chrome.posts.at(-1)).toEqual({
      url: "https://login.example/session",
      body: `email=me%40example.com&password=${PASSWORD.replaceAll(" ", "+")}`,
    });
    expect(JSON.stringify(res)).not.toContain(PASSWORD);
    expect(JSON.stringify(await t.tdb.db.select().from(event))).not.toContain(PASSWORD);
  });

  it("goes through a name page and a password page, then hands a code to the owner", async () => {
    await save("steps.example", "me@example.com");
    const res = await signIn("https://steps.example/");
    expect(res).toMatchObject({
      status: "ok",
      result: {
        status: "needs_you",
        why: "It asks for a code.",
        url: "https://steps.example/code",
      },
    });
  });

  it.each(["https://login.example.evil.test/", "https://blog.login.example/"])(
    "gives %s nothing",
    async (url) => {
      await save("login.example", "me@example.com");
      const [posts, sent] = [chrome.posts.length, chrome.sent.length];
      const res = await signIn(url);
      expect(res).toMatchObject({ status: "error", code: "not_found" });
      expect(chrome.posts.length).toBe(posts);
      expect(JSON.stringify(chrome.sent.slice(sent))).not.toContain(PASSWORD);
    },
  );
});
