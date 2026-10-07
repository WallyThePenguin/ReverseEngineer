// Hearth's own, beyond the buttons on its pages: its requests (/api/...) never open in your Chrome
// for Jarvis, where they'd go with your sign-in, and on a page last seen as Hearth's own (by the
// mark in its head, at an address Hearth wasn't told about) a dialog's OK and a sign-in are yours.

import { randomBytes } from "node:crypto";
import { type Caller, jarvisCaller, ownerCaller, systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { HEARTH_PAGE } from "./classify.ts";
import { BROWSER_SERVICE } from "./client.ts";
import { FakeBrowser, instantLoads } from "./testing.ts";
import { VAULT_SERVICE, Vault } from "./vault.ts";

const SHOP = "https://shop.example/";
const MIRROR = "https://mirror.example/";
const CONNECT = "http://127.0.0.1:4400/api/google/connect?for=gmail";
let t: TestKernel;
let chrome: FakeBrowser;
const jarvis = jarvisCaller("agent");

beforeEach(async () => {
  instantLoads();
  vi.stubEnv("HEARTH_PORT", "4400");
  t = await createTestKernel(ALL_MODULES);
  chrome = new FakeBrowser({
    [SHOP]: { title: "Shop", text: "Kettles" },
    [MIRROR]: { title: "Hearth", text: "[button E1: Disconnect Slack]", mark: true },
    [CONNECT]: { title: "Sign in - Google Accounts", text: "Allow" },
  });
  t.kernel.services[BROWSER_SERVICE] = chrome;
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.destroy();
});

async function ok<T>(name: string, input: unknown, caller: Caller = jarvis): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const urls = async () =>
  (await ok<{ tabs: { url: string }[] }>("browser.tabs", {})).tabs.map((x) => x.url);

describe("Hearth's own requests", () => {
  it("never open in your Chrome for Jarvis, in a new tab or an open one", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: SHOP });
    const steps = [
      ["browser.open", { url: CONNECT }],
      ["browser.navigate", { tabId, url: CONNECT }],
    ] as const;
    for (const [name, input] of steps)
      for (const caller of [jarvis, systemCaller()])
        expect(await t.kernel.execute(name, input, caller)).toMatchObject({
          status: "error",
          code: "forbidden",
        });
    expect(await urls()).toEqual([SHOP]);
    // Yours to open, as ever.
    await ok("browser.navigate", { tabId, url: CONNECT }, ownerCaller());
    expect(await urls()).toEqual([CONNECT]);
  });
});

describe("a page last seen as Hearth's own", () => {
  it("leaves a dialog's OK to you, though Cancel is fine", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: MIRROR });
    // Jarvis looks before a step that acts, and saw the mark.
    expect(await t.kernel.execute("browser.key", { tabId, keys: "Tab" }, jarvis)).toMatchObject({
      status: "denied",
      reason: HEARTH_PAGE,
    });
    chrome.openDialog(tabId, { type: "confirm", message: "Disconnect Slack?", url: MIRROR });
    const accept = { tabId, accept: true };
    expect(await t.kernel.execute("browser.dialog", accept, jarvis)).toMatchObject({
      status: "denied",
      reason: HEARTH_PAGE,
    });
    expect(await t.kernel.execute("browser.dialog", accept, systemCaller())).toMatchObject({
      status: "error",
      code: "forbidden",
      message: HEARTH_PAGE,
    });
    expect(await ok("browser.dialog", { tabId, accept: false })).toMatchObject({
      accepted: false,
    });
  });

  it("answers a dialog on any other page as before, even in a tab that showed Hearth", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: MIRROR });
    await t.kernel.execute("browser.key", { tabId, keys: "Tab" }, jarvis);
    await ok("browser.navigate", { tabId, url: SHOP });
    chrome.openDialog(tabId, { type: "alert", message: "Saved", url: SHOP });
    expect(await ok("browser.dialog", { tabId, accept: true })).toMatchObject({ accepted: true });
  });

  it("keeps its sign-in yours", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: MIRROR });
    for (const caller of [jarvis, systemCaller()])
      expect(await t.kernel.execute("browser.sign_in", { tabId }, caller)).toMatchObject({
        status: "error",
        code: "forbidden",
        message: HEARTH_PAGE,
      });
  });
});
