import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { ChromiumBrowser, chromiumForTests } from "./chromium.ts";
import { BROWSER_SERVICE } from "./client.ts";
import { pacing } from "./pace.ts";
import { loadTiming } from "./page.ts";

// D52 against real pages in Chromium: trusted sites and the floor, keys, dialogs, pop-ups,
// cookie banners, moving around and scrolling.
const SHOP = "https://shop.example/";
const PAGES: Record<string, string> = {
  [SHOP]: `<!doctype html><title>Shop</title>
    <div id="cookie-banner"><p>We use cookies.</p><button>Accept all</button><button>Reject all</button></div>
    <form method="post" action="/save"><input name="nick" aria-label="Nickname"><button>Save</button></form>
    <form method="post" action="/order"><input name="qty" aria-label="Quantity"><button>Place order</button></form>
    <nav><a role="tab" href="https://shop.example/tab2"
      onclick="event.preventDefault(); document.getElementById('panel').textContent = 'Tab two'">Second tab</a></nav>
    <p id="panel">Tab one</p>
    <button onclick="alert('Saved!')">Show alert</button>
    <button onclick="document.getElementById('c').textContent = confirm('Delete this note?') ? 'yes' : 'no'">Remove note</button>
    <p id="c"></p>
    <button onclick="window.open('https://shop.example/k/1')">Open kettle</button>
    <textarea aria-label="Message"></textarea>
    <form action="/search" method="get" role="search"><input name="q" aria-label="Search"></form>
    <div style="height:3000px"></div>`,
  "https://shop.example/save": "<title>Saved</title><p>Saved</p>",
  "https://shop.example/order": "<title>Thanks</title><p>Order placed</p>",
  "https://shop.example/k/1": "<title>Kettle</title><p>Steel kettle</p>",
  "https://shop.example/search": "<title>Results</title><p>3 kettles</p>",
  "https://shop.example/draft": `<title>Draft</title><button>Start</button>
    <script>addEventListener("beforeunload", (e) => { e.preventDefault(); e.returnValue = ""; })</script>`,
};

const hasChromium = chromiumForTests();
let t: TestKernel;
let chrome: ChromiumBrowser;
const jarvis = jarvisCaller("agent");

beforeAll(async () => {
  if (hasChromium) chrome = await ChromiumBrowser.launch(PAGES);
});
afterAll(async () => {
  await chrome?.close();
});
beforeEach(async () => {
  if (!hasChromium) return;
  Object.assign(loadTiming, { startMs: 250, pollMs: 50, settleMs: 50 });
  pacing.enabled = false;
  t = await createTestKernel(ALL_MODULES);
  t.kernel.services[BROWSER_SERVICE] = chrome;
});
afterEach(async () => {
  await t?.destroy();
});

const run = (name: string, input: unknown, caller: Caller = jarvis) =>
  t.kernel.execute<Record<string, unknown>>(name, input, caller);

async function ok<T = Record<string, unknown>>(name: string, input: unknown): Promise<T> {
  const res = await run(name, input);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result as T;
}

async function trust(site: string) {
  const sites = await ok<{ blocked: string[] }>("browser.sites", {});
  await t.kernel.execute(
    "browser.set_sites",
    { allowed: [site], blocked: sites.blocked },
    ownerCaller(),
  );
}

/** Opens the shop and reads it; `ref("Save")` is the reference the reader gave "Save". */
async function openShop(url = SHOP) {
  const { tabId } = await ok<{ tabId: number }>("browser.open", { url });
  const { text } = await ok<{ text: string }>("browser.read", { tabId });
  const ref = (label: string) => {
    const m = new RegExp(`\\[[a-z ]+ (E\\d+): ${label}`).exec(text);
    if (!m) throw new Error(`No ${label} in ${text}`);
    return m[1]!;
  };
  return { tabId, ref };
}

describe.skipIf(!hasChromium)("Jarvis's browser, D52", () => {
  it("acts freely on a trusted site, but the floor still asks", async () => {
    const { tabId, ref } = await openShop();
    const save = await run("browser.click", { tabId, ref: ref("Save") });
    expect(save).toMatchObject({ status: "error", code: "forbidden" });
    expect(save).toMatchObject({ message: expect.stringMatching(/trusts/) });
    await trust("shop.example");
    expect(await ok("browser.click", { tabId, ref: ref("Save") })).toMatchObject({
      url: "https://shop.example/save",
    });
    const again = await openShop();
    const order = await run("browser.click", { tabId: again.tabId, ref: again.ref("Place order") });
    expect(order).toMatchObject({ status: "error", code: "forbidden" });
    expect(order).toMatchObject({ message: expect.stringMatching(/even on a trusted site/) });
    expect(chrome.posts.map((p) => p.url)).not.toContain("https://shop.example/order");
  });

  it("lets cookie banners and tabs be clicked, and rejects cookies", async () => {
    const { tabId, ref } = await openShop();
    await ok("browser.click", { tabId, ref: ref("Second tab") });
    expect(await chrome.page(tabId).textContent("#panel")).toBe("Tab two");
    expect(await ok("browser.reject_cookies", { tabId })).toMatchObject({ pressed: "Reject all" });
    expect(await ok("browser.click", { tabId, ref: ref("Accept all") })).toMatchObject({
      pressed: "Accept all",
    });
  });

  it("presses keys and combinations, with Enter judged like a click", async () => {
    const { tabId, ref } = await openShop();
    const posted = chrome.posts.length;
    await ok("browser.type", { tabId, ref: ref("Message"), text: "hello" });
    expect(await run("browser.key", { tabId, keys: "Enter" })).toMatchObject({ code: "forbidden" });
    await ok("browser.key", { tabId, keys: "shift+Enter" });
    await ok("browser.key", { tabId, keys: "ctrl+a Backspace" });
    expect(await chrome.page(tabId).inputValue("textarea")).toBe("");
    expect(await run("browser.key", { tabId, keys: "ctrl+v" })).toMatchObject({
      code: "forbidden",
    });
    await ok("browser.type", { tabId, ref: ref("Nickname"), text: "kit" });
    expect(await run("browser.key", { tabId, keys: "Enter" })).toMatchObject({ code: "forbidden" });
    await ok("browser.type", { tabId, ref: ref("Search"), text: "kettle" });
    await ok("browser.key", { tabId, keys: "Backspace", repeat: 2 });
    const searched = await ok("browser.key", { tabId, keys: "Enter" });
    expect(searched).toMatchObject({ url: "https://shop.example/search?q=kett" });
    expect(chrome.posts).toHaveLength(posted);
  });

  it("stops at a dialog, answers it, and holds a confirm that deletes to the rules", async () => {
    const { tabId, ref } = await openShop();
    const shown = await ok("browser.click", { tabId, ref: ref("Show alert") });
    expect(shown).toMatchObject({ dialog: { type: "alert", message: "Saved!" } });
    expect(await run("browser.read", { tabId })).toMatchObject({
      status: "error",
      code: "conflict",
      message: expect.stringMatching(/dialog is open/),
    });
    const tabs = await ok<{ tabs: { dialog?: unknown }[] }>("browser.tabs", {});
    expect(tabs.tabs.find((x) => x.dialog)).toBeTruthy();
    await ok("browser.dialog", { tabId, accept: true });

    await ok("browser.click", { tabId, ref: ref("Remove note") });
    expect(await run("browser.dialog", { tabId, accept: true })).toMatchObject({
      code: "forbidden",
    });
    await ok("browser.dialog", { tabId, accept: false });
    expect(await chrome.page(tabId).textContent("#c")).toBe("no");
    await trust("shop.example");
    await ok("browser.click", { tabId, ref: ref("Remove note") });
    await ok("browser.dialog", { tabId, accept: true });
    expect(await chrome.page(tabId).textContent("#c")).toBe("yes");
  });

  it("leaves a page with unsaved work by itself only in its own tab", async () => {
    const own = await openShop("https://shop.example/draft");
    await ok("browser.click", { tabId: own.tabId, ref: own.ref("Start") });
    expect(await ok("browser.navigate", { tabId: own.tabId, url: SHOP })).toMatchObject({
      finalUrl: SHOP,
    });
    // In a tab you handed over, the unsaved work may be yours: Jarvis has to answer.
    const yours = await chrome.hand("https://shop.example/draft");
    await chrome.page(yours).click("button");
    expect(await run("browser.navigate", { tabId: yours, url: SHOP })).toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/"leave site\?" dialog is open/),
    });
    expect(await ok("browser.dialog", { tabId: yours, accept: true })).toMatchObject({
      answered: "beforeunload",
      url: SHOP,
    });
  });

  it("adopts the pop-ups its tabs open, and says so", async () => {
    const { tabId, ref } = await openShop();
    const res = await ok<{ opened: { tabId: number; url: string }[] }>("browser.click", {
      tabId,
      ref: ref("Open kettle"),
    });
    expect(res.opened).toEqual([{ tabId: expect.any(Number), url: "https://shop.example/k/1" }]);
    const popup = res.opened[0]!.tabId;
    expect(await ok("browser.read", { tabId: popup })).toMatchObject({ title: "Kettle" });
    expect(await ok("browser.close", { tabId: popup })).toEqual({
      closed: true,
      handedBack: false,
    });
  });

  it("goes back, forward and reloads, and scrolls", async () => {
    const { tabId } = await openShop();
    await ok("browser.navigate", { tabId, url: "https://shop.example/k/1" });
    expect(await ok("browser.navigate", { tabId, url: "back" })).toMatchObject({
      finalUrl: SHOP,
      title: "Shop",
      errorText: null,
    });
    expect(await ok("browser.navigate", { tabId, url: "forward" })).toMatchObject({
      finalUrl: "https://shop.example/k/1",
    });
    expect(await ok("browser.navigate", { tabId, url: "reload" })).toMatchObject({
      finalUrl: "https://shop.example/k/1",
    });
    await ok("browser.navigate", { tabId, url: "back" });
    const down = await ok<{ position: { y: number } }>("browser.scroll", {
      tabId,
      direction: "down",
      amount: 5,
    });
    expect(down.position.y).toBeGreaterThan(0);
    expect(chrome.sent.every((s) => s.method !== "Runtime.evaluate" || s.params.contextId)).toBe(
      true,
    );
  });
});
