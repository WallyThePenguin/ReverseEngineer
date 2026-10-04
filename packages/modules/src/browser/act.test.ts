import { approval, audit, event } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { ChromiumBrowser, chromiumForTests } from "./chromium.ts";
import { BROWSER_SERVICE } from "./client.ts";
import { pacing } from "./pace.ts";
import { loadTiming } from "./page.ts";

// The browser's hands, against real pages in Chromium (skipped where none is installed).
const SHOP = "https://shop.example/";
const PAGES: Record<string, string> = {
  [SHOP]: `<!doctype html><title>Shop</title>
    <form role="search" action="/search" method="get">
      <input name="q" aria-label="Search"><button>Search</button>
    </form>
    <label><input type="checkbox" name="gift"> Gift wrap</label>
    <select aria-label="Size"><option>Small</option><option>Large</option></select>
    <button onclick="document.getElementById('extra').hidden = false">Show details</button>
    <p id="extra" hidden>Ships in 2 days</p>
    <form method="post" action="/order">
      <input name="note" aria-label="Note"> <input type="password" name="pin" aria-label="PIN">
      <button>Place order</button>
    </form>
    <label><input type="checkbox" role="switch"> Make my wishlist public</label>
    <div style="position:relative">
      <button>Hidden deal</button>
      <div style="position:absolute;inset:0;background:white">Cookie banner</div>
    </div>`,
  "https://shop.example/search": "<title>Results</title><p>3 kettles</p>",
  "https://shop.example/order": "<title>Thanks</title><p>Order placed</p>",
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
  // Real pages take a moment to start navigating after a click.
  Object.assign(loadTiming, { startMs: 250, pollMs: 50, settleMs: 50 });
  pacing.enabled = false;
  t = await createTestKernel(ALL_MODULES);
  t.kernel.services[BROWSER_SERVICE] = chrome;
});
afterEach(async () => {
  await t?.destroy();
});

async function ok<T>(name: string, input: unknown, caller: Caller = jarvis): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

async function openShop() {
  const { tabId } = await ok<{ tabId: number }>("browser.open", { url: SHOP });
  const page = await ok<{ text: string; sends: string[] }>("browser.read", { tabId });
  return { tabId, page };
}

describe.skipIf(!hasChromium)("Jarvis's hands in Chrome", () => {
  it("numbers what can be pressed or typed into, and says what would send", async () => {
    const { page } = await openShop();
    expect(page.text).toContain("[field E1: Search] [button E2: Search]");
    expect(page.text).toContain("[checkbox E3: Gift wrap, unchecked]");
    expect(page.text).toContain("[select E4: Size = Small]");
    expect(page.text).toContain("[button E5: Show details]");
    expect(page.text).toContain(
      "[field E6: Note] [password field E7: PIN] [button E8: Place order]",
    );
    expect(page.sends).toEqual([
      "E6 Note",
      "E7 PIN",
      "E8 Place order",
      "E9 Make my wishlist public",
    ]);
  });

  it("clicks, ticks, picks and searches without asking", async () => {
    const { tabId } = await openShop();
    await ok("browser.click", { tabId, ref: "E5" });
    expect(await chrome.page(tabId).isVisible("#extra")).toBe(true);
    await ok("browser.choose", { tabId, ref: "E3", value: "on" });
    expect(await chrome.page(tabId).isChecked("input[name=gift]")).toBe(true);
    expect(await ok("browser.choose", { tabId, ref: "E4", value: "large" })).toMatchObject({
      now: "= Large",
    });
    await ok("browser.type", { tabId, ref: "E1", text: "kettle" });
    const res = await ok<{ url: string }>("browser.click", { tabId, ref: "E2" });
    expect(res.url).toBe("https://shop.example/search?q=kettle");
  });

  it("won't press what sends, type a password, or click through a banner", async () => {
    const { tabId } = await openShop();
    const order = await t.kernel.execute("browser.click", { tabId, ref: "E8" }, jarvis);
    expect(order).toMatchObject({ status: "error", code: "forbidden" });
    const pin = await t.kernel.execute("browser.type", { tabId, ref: "E7", text: "1234" }, jarvis);
    expect(pin).toMatchObject({ status: "error", code: "forbidden" });
    const shared = await t.kernel.execute(
      "browser.choose",
      { tabId, ref: "E9", value: "on" },
      jarvis,
    );
    expect(shared).toMatchObject({ status: "error", code: "forbidden" });
    const covered = await t.kernel.execute("browser.click", { tabId, ref: "E10" }, jarvis);
    expect(covered).toMatchObject({ status: "error", message: expect.stringMatching(/covers/) });
    // Arrows on a list change the choice, so they go through browser_choose.
    await chrome.page(tabId).focus("select");
    const arrow = await t.kernel.execute("browser.key", { tabId, keys: "ArrowDown" }, jarvis);
    expect(arrow).toMatchObject({ status: "error", code: "forbidden" });
    expect(chrome.posts).toEqual([]);
  });

  it("submits only with the owner's yes, and only what it said it would press", async () => {
    const { tabId } = await openShop();
    await ok("browser.type", { tabId, ref: "E6", text: "leave at door" });
    const asked = await t.kernel.execute(
      "browser.submit",
      { tabId, ref: "E8", label: "Place order", site: "shop.example" },
      jarvis,
    );
    expect(asked).toMatchObject({
      status: "pending_approval",
      summary: 'Press "Place order" on shop.example',
    });
    expect(chrome.posts).toEqual([]);
    const [row] = await t.tdb.db.select().from(approval);
    const done = await t.kernel.decideApproval(row!.id, "approve", ownerCaller());
    expect(done).toMatchObject({ status: "ok", result: { pressed: "Place order" } });
    expect(chrome.posts).toEqual([
      { url: "https://shop.example/order", body: "note=leave+at+door&pin=" },
    ]);

    // Pinned to what it sends: the card shows it, and a page that changed it gets nothing.
    const again0 = await openShop();
    await ok("browser.type", { tabId: again0.tabId, ref: "E6", text: "ring twice" });
    const submit = t.kernel.registry.action("browser.submit")!;
    const services = { service: <T>(n: string) => t.kernel.services[n] as T };
    const base = { tabId: again0.tabId, ref: "E8", label: "Place order", site: "shop.example" };
    const pinned = await submit.pin!(base, services);
    expect(pinned?.extra).toEqual({
      sends: { url: SHOP, fields: [{ label: "Note", value: "ring twice" }] },
    });
    const input = { ...base, ...pinned!.extra };
    expect(submit.summarize!(input)).toBe(
      'Press "Place order" on shop.example, sending Note: "ring twice"',
    );
    await chrome.page(again0.tabId).fill("input[name=note]", "send it elsewhere");
    const changed = await t.kernel.execute("browser.submit", input, ownerCaller());
    expect(changed).toMatchObject({ status: "error", code: "conflict" });
    expect(chrome.posts).toHaveLength(1);

    const again = await openShop();
    const wrong = await t.kernel.execute(
      "browser.submit",
      { tabId: again.tabId, ref: "E8", label: "Search", site: "shop.example" },
      ownerCaller(),
    );
    expect(wrong).toMatchObject({ status: "error", code: "conflict" });
    // Approved for one site, never pressed on another.
    const elsewhere = await t.kernel.execute(
      "browser.submit",
      { tabId: again.tabId, ref: "E8", label: "Place order", site: "other.example" },
      ownerCaller(),
    );
    expect(elsewhere).toMatchObject({ status: "error", code: "conflict" });
  });

  it("keeps what's typed out of the logs", async () => {
    const { tabId } = await openShop();
    await ok("browser.type", { tabId, ref: "E1", text: "kettle" });
    const events = await t.tdb.db.select().from(event);
    expect(JSON.stringify(events)).not.toContain("kettle");
    // The audit log keeps the input of ordinary actions; typed text is the owner's to see.
    const [row] = await t.tdb.db.select().from(audit).where(eq(audit.action, "browser.type"));
    expect(row?.outcome).toBe("ok");
  });
});
