import { type Caller, isVisibleTo, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { BROWSER_SERVICE } from "./client.ts";
import { FakeBrowser, instantLoads } from "./testing.ts";

const SHOP = "https://shop.example/";
let t: TestKernel;
let chrome: FakeBrowser;
const jarvis = jarvisCaller("agent");

beforeEach(async () => {
  instantLoads();
  t = await createTestKernel(ALL_MODULES);
  chrome = new FakeBrowser({
    [SHOP]: {
      title: "Shop",
      text: "# Kettles\nOur best steel kettle [L1] is back. Reviews [L2]",
      links: ["https://shop.example/k/1", "https://reviews.example/kettle"],
    },
    "https://shop.example/k/1": { title: "Steel kettle", text: "Steel kettle, $40" },
    "https://long.example/": { title: "Long", text: "x".repeat(30_000) },
  });
  t.kernel.services[BROWSER_SERVICE] = chrome;
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown, caller: Caller = jarvis): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

describe("Jarvis's browser", () => {
  it("opens a page in your Chrome, reads it, and follows its links by reference", async () => {
    const opened = await ok<{ tabId: number }>("browser.open", { url: SHOP });
    expect(opened).toEqual({ tabId: 1, url: SHOP, loaded: true });
    expect(await t.events("browser.opened")).toHaveLength(1);

    const page = await ok("browser.read", { tabId: 1 });
    expect(page).toMatchObject({
      url: SHOP,
      title: "Shop",
      links: ["L1 https://shop.example/k/1", "L2 https://reviews.example/kettle"],
      next: null,
    });
    // The page's text is read in an isolated world, never the page's own scripts' world.
    expect(chrome.cdpMethods()).toEqual([
      "Page.getFrameTree",
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
    ]);

    await ok("browser.open", { tabId: 1, link: "L1" });
    expect(chrome.tabs[0]?.url).toBe("https://shop.example/k/1");
    const missing = await t.kernel.execute("browser.open", { tabId: 1, link: "L1" }, jarvis);
    expect(missing).toMatchObject({ status: "error", code: "not_found" });
  });

  it("keeps everyone but you off your blocked sites", async () => {
    const res = await t.kernel.execute("browser.open", { url: "https://www.paypal.com/" }, jarvis);
    expect(res).toMatchObject({ status: "error", code: "forbidden" });
    const handed = chrome.hand("https://www.paypal.com/activity");
    const read = await t.kernel.execute("browser.read", { tabId: handed.tabId }, jarvis);
    expect(read).toMatchObject({ status: "error", code: "forbidden" });
    await ok("browser.open", { url: "https://www.paypal.com/" }, ownerCaller());
  });

  it("opens an address exactly, #fragment included", async () => {
    const url = "https://mail.example/mail/u/0/#inbox";
    expect(await ok("browser.open", { url })).toMatchObject({ url });
    expect(chrome.calls.find((c) => c.method === "tabs.open")?.params).toEqual({ url });
  });

  it("reads a long page in parts", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", {
      url: "https://long.example/",
    });
    const first = await ok<{ text: string; next: { offset: number } }>("browser.read", { tabId });
    expect(first.text).toHaveLength(12_000);
    expect(first.next).toEqual({ offset: 12_000 });
    const last = await ok<{ text: string; next: null }>("browser.read", {
      tabId,
      offset: 24_000,
    });
    expect(last.text).toHaveLength(6_000);
    expect(last.next).toBeNull();
  });

  it("looks at a tab as a picture", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: SHOP });
    const shot = await ok("browser.screenshot", { tabId });
    expect(shot).toEqual({
      tabId,
      url: SHOP,
      modelImages: [{ mimeType: "image/jpeg", data: "SlBFRw==" }],
    });
    expect(chrome.calls.map((c) => c.method)).toContain("tabs.show");
  });

  it("closes its own tabs and gives yours back", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: SHOP });
    const yours = chrome.hand("https://mail.example/");
    expect(await ok("browser.close", { tabId })).toEqual({ closed: true, handedBack: false });
    expect(await ok("browser.close", { tabId: yours.tabId })).toEqual({
      closed: false,
      handedBack: true,
    });
    expect(chrome.calls.map((c) => c.method).filter((m) => m.startsWith("tabs.c"))).toEqual([
      "tabs.close",
    ]);
    expect(chrome.calls.map((c) => c.method)).toContain("tabs.release");
  });

  it("is never offered to outside agents or integrations", async () => {
    for (const name of ["browser.tabs", "browser.open", "browser.read"]) {
      const def = t.kernel.registry.action(name);
      expect(def && isVisibleTo(def, "mcp_client")).toBe(false);
      expect(def && isVisibleTo(def, "integration")).toBe(false);
    }
    const res = await t.kernel.execute(
      "browser.tabs",
      {},
      { principal: "mcp:laptop", kind: "mcp_client", origin: "agent", via: "mcp" },
    );
    expect(res).toMatchObject({ status: "denied" });
  });

  it("says plainly when Chrome isn't connected", async () => {
    chrome.connected = false;
    const res = await t.kernel.execute("browser.open", { url: SHOP }, jarvis);
    expect(res).toMatchObject({ status: "error", code: "unavailable" });
    delete t.kernel.services[BROWSER_SERVICE];
    const none = await t.kernel.execute("browser.tabs", {}, jarvis);
    expect(none).toMatchObject({ status: "error", code: "unavailable" });
  });
});
