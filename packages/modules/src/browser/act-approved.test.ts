// A step Jarvis asked for on a page it read (by an E-reference) runs only once you say yes, and
// then in Hearth's server, which never read the page: the page it read travels with the step, so
// it presses on that page and nowhere else.
import { approval } from "@hearth/db";
import { jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { ChromiumBrowser, chromiumForTests } from "./chromium.ts";
import { HEARTH_PAGE } from "./classify.ts";
import { BROWSER_SERVICE } from "./client.ts";
import { pacing } from "./pace.ts";
import { forgetLinks, loadTiming } from "./page.ts";

const SHOP = "https://shop.example/";
const STAGED = "https://staged.example/";
const PAGES: Record<string, string> = {
  [SHOP]: `<!doctype html><title>Shop</title>
    <form method="post" action="/order">
      <input name="note" aria-label="Note"> <button>Place order</button>
    </form>`,
  "https://shop.example/order": "<title>Thanks</title><p>Order placed</p>",
  // Hearth's own page at an address it wasn't told about, with the same references.
  [STAGED]: `<!doctype html><head><meta name="hearth-build" content="test"><title>Hearth</title>
    </head><button data-hearth="E2" onclick="document.title = 'Pressed'">Place order</button>`,
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
  vi.stubEnv("HEARTH_PORT", "4400");
  t = await createTestKernel(ALL_MODULES);
  t.kernel.services[BROWSER_SERVICE] = chrome;
  chrome.posts.length = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t?.destroy();
});

/** Jarvis reads the shop and asks to place the order; the server, which read nothing, waits. */
async function asked(): Promise<number> {
  const open = await t.kernel.execute<{ tabId: number }>("browser.open", { url: SHOP }, jarvis);
  if (open.status !== "ok") throw new Error(JSON.stringify(open));
  const { tabId } = open.result;
  const read = await t.kernel.execute<{ text: string }>("browser.read", { tabId }, jarvis);
  expect(read).toMatchObject({
    result: { text: expect.stringContaining("[button E2: Place order]") },
  });
  // Whatever page Jarvis says it read, Hearth puts in the one it did.
  const submit = { tabId, ref: "E2", label: "Place order", site: "shop.example", doc: 1 };
  expect(await t.kernel.execute("browser.submit", submit, jarvis)).toMatchObject({
    status: "pending_approval",
  });
  forgetLinks(tabId);
  return tabId;
}
async function approve() {
  const [row] = await t.tdb.db.select().from(approval);
  return t.kernel.decideApproval(row!.id, "approve", ownerCaller());
}

describe.skipIf(!hasChromium)("a step you approve", () => {
  it("presses on the page Jarvis read", async () => {
    await asked();
    expect(await approve()).toMatchObject({ status: "ok", result: { pressed: "Place order" } });
    expect(chrome.posts).toEqual([{ url: "https://shop.example/order", body: "note=" }]);
  });

  it("presses nothing once that page was loaded again", async () => {
    const tabId = await asked();
    await chrome.page(tabId).reload();
    expect(await approve()).toMatchObject({ status: "error", code: "conflict" });
    expect(chrome.posts).toEqual([]);
  });

  it("presses nothing on Hearth's own page that took its place", async () => {
    const tabId = await asked();
    await chrome.page(tabId).goto(STAGED);
    expect(await approve()).toMatchObject({
      status: "error",
      code: "forbidden",
      message: HEARTH_PAGE,
    });
    expect(await chrome.page(tabId).title()).toBe("Hearth");
  });
});
