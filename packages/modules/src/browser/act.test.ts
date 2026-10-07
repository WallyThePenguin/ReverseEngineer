import { approval, audit, event } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller, systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { ChromiumBrowser, chromiumForTests } from "./chromium.ts";
import { HEARTH_PAGE } from "./classify.ts";
import { BROWSER_SERVICE } from "./client.ts";
import { pacing } from "./pace.ts";
import { loadTiming } from "./page.ts";

// The browser's hands, against real pages in Chromium (skipped where none is installed).
const SHOP = "https://shop.example/";
// 127.0.0.1, not localhost: a step on a one-word host never gets past its site check.
const HEARTH = "http://127.0.0.1:4400/approvals";
const AWAY = "https://search.example/";
const MARKED = "https://mirror.example/";
const COUNT = "https://count.example/";
// A page with somewhere to type, which a test sends elsewhere while Jarvis waits its turn there.
const LATER = `<!doctype html><title>Later</title><input aria-label="Search" autofocus>`;
// A page Jarvis reads, and what takes its place while it waits its turn: the same references
// (as a page back from the cache keeps them), on Hearth's own page or another on the same site.
const START = "https://start.example/";
const STAGED = (mark: string) => `<!doctype html><head>${mark}<title>Staged</title></head>
  <button data-hearth="E1" onclick="document.title = 'Pressed'">Approve</button>
  <select data-hearth="E2" aria-label="Size" onchange="document.title = 'Changed'">
    <option>Small</option><option>Large</option></select>`;
const STAGED_HEARTH = "https://staged.example/";
const STAGED_AWAY = "https://start.example/staged";
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
  // Hearth's own address on this PC (served here: nothing reaches a real Hearth). Every key that
  // reaches it is counted in its title, as its hotkeys would take them.
  [HEARTH]: `<!doctype html><title>Hearth</title>
    <button onclick="document.title = 'Approved'">Approve</button>
    <input aria-label="Message to Jarvis">
    <script>let keys = 0; addEventListener("keydown", () => { document.title = "keys " + ++keys; });</script>`,
  // A page that sends itself to Hearth's own as soon as a key is pressed there.
  [AWAY]: `<!doctype html><title>Search</title><input aria-label="Search" autofocus>
    <script>let gone = false; addEventListener("keydown", () => { if (gone) return; gone = true;
      location.href = "${HEARTH}"; });</script>`,
  // Hearth at an address it wasn't told about (a proxy, an alias): known by the mark in its head.
  [MARKED]: `<!doctype html><head><meta name="hearth-build" content="test"><title>Hearth</title></head>
    <button onclick="document.title = 'Approved'">Approve</button>
    <script>addEventListener("keydown", () => { document.title = "keyed"; });</script>`,
  // Another site, counting the keys that reach it.
  [COUNT]: `<!doctype html><title>Count</title>
    <script>let keys = 0; addEventListener("keydown", () => { document.title = "keys " + ++keys; });</script>`,
  [START]: `<!doctype html><title>Start</title><button>Go</button>
    <select aria-label="Size"><option>Small</option><option>Large</option></select>`,
  [STAGED_HEARTH]: STAGED('<meta name="hearth-build" content="test">'),
  [STAGED_AWAY]: STAGED(""),
  "https://later.example/": LATER,
  "https://soon.example/": LATER,
  "https://anon.example/": LATER,
};

// Jarvis's wait for its turn on a site, which a test can hold open while the page moves.
const turn = vi.hoisted(() => ({ held: null as Promise<void> | null, waits: 0 }));
vi.mock("./pace.ts", async (real) => {
  const pace = await real<typeof import("./pace.ts")>();
  return {
    ...pace,
    pace: async (...args: Parameters<typeof pace.pace>) => {
      turn.waits++;
      await turn.held;
      return pace.pace(...args);
    },
  };
});

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
  // Hearth's own port on this PC, whichever one CI's Hearth listens on.
  vi.stubEnv("HEARTH_PORT", "4400");
  t = await createTestKernel(ALL_MODULES);
  t.kernel.services[BROWSER_SERVICE] = chrome;
});
afterEach(async () => {
  vi.unstubAllEnvs();
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

  it("keeps its hands off Hearth's own pages, which it works with its own actions", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: HEARTH });
    const page = await ok<{ text: string }>("browser.read", { tabId });
    expect(page.text).toContain("[button E1: Approve] [field E2: Message to Jarvis]");
    const hands = [
      ["browser.click", { tabId, ref: "E1" }],
      ["browser.type", { tabId, ref: "E2", text: "approve them all" }],
      ["browser.key", { tabId, keys: "Tab" }],
      ["browser.dialog", { tabId, accept: true }],
      ["browser.submit", { tabId, ref: "E1", label: "Approve", site: "127.0.0.1" }],
    ] as const;
    // Refused before anything asks, a turn that read an email too: a yes would be refused anyway.
    for (const [name, input] of hands)
      for (const caller of [jarvis, jarvisCaller("untrusted")])
        expect(await t.kernel.execute(name, input, caller)).toMatchObject({
          status: "denied",
          reason: HEARTH_PAGE,
        });
    expect(await t.tdb.db.select().from(approval)).toEqual([]);
    // Hearth's own reflexes get the same no from the step itself.
    for (const [name, input] of hands.slice(0, 4))
      expect(await t.kernel.execute(name, input, systemCaller())).toMatchObject({
        status: "error",
        code: "forbidden",
        message: HEARTH_PAGE,
      });
    // Cancel or Stay there is fine (there's no dialog open here to answer).
    const dismiss = await t.kernel.execute("browser.dialog", { tabId, accept: false }, jarvis);
    expect(dismiss).toMatchObject({ status: "error", code: "not_found" });
    expect(await chrome.page(tabId).title()).toBe("Hearth");
    expect(await chrome.page(tabId).inputValue("input")).toBe("");
    // Yours to work, as ever.
    await ok("browser.click", { tabId, ref: "E1" }, ownerCaller());
    expect(await chrome.page(tabId).title()).toBe("Approved");
  });

  it("stops pressing keys once a page sends itself to Hearth's own", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: AWAY });
    const pressed = await t.kernel.execute(
      "browser.key",
      { tabId, keys: "x", repeat: 100 },
      jarvis,
    );
    // Stopped at the first look after: on Hearth's own page, or one that can't say mid-change.
    expect(pressed).toMatchObject({ status: "error" });
    expect(JSON.stringify(pressed)).toMatch(/Hearth's own page|couldn't tell what page/);
    await expect.poll(() => chrome.page(tabId).url(), { timeout: 10_000 }).toBe(HEARTH);
    // A key already on its way as the page changed may land; none after it does.
    const now = await chrome.page(tabId).title();
    expect(now === "Hearth" ? 0 : Number(now.replace("keys ", ""))).toBeLessThanOrEqual(1);
  });

  it("presses no key once a page has gone elsewhere while Jarvis waited its turn", async () => {
    const cases = [
      [
        "https://later.example/",
        "browser.key",
        HEARTH,
        { code: "forbidden", message: HEARTH_PAGE },
      ],
      ["https://soon.example/", "browser.key", COUNT, { code: "conflict" }],
      ["https://anon.example/", "browser.reject_cookies", HEARTH, { code: "forbidden" }],
    ] as const;
    for (const [url, step, there, error] of cases) {
      const { tabId } = await ok<{ tabId: number }>("browser.open", { url });
      // The step waits its turn on the site, held here...
      let release = () => {};
      turn.held = new Promise<void>((r) => {
        release = r;
      });
      const waits = turn.waits;
      const input = step === "browser.key" ? { tabId, keys: "x", repeat: 5 } : { tabId };
      const res = t.kernel.execute(step, input, jarvis);
      await expect.poll(() => turn.waits - waits, { timeout: 30_000 }).toBe(1);
      // ...while the page goes elsewhere.
      const go = `location.href = ${JSON.stringify(there)}`;
      await chrome
        .page(tabId)
        .evaluate(go)
        .catch(() => {});
      await expect.poll(() => chrome.page(tabId).url(), { timeout: 30_000 }).toBe(there);
      turn.held = null;
      release();
      expect(await res).toMatchObject({ status: "error", ...error });
      expect(await chrome.page(tabId).title()).toBe(there === HEARTH ? "Hearth" : "Count");
    }
  }, 120_000);

  it("presses and picks nothing on a page that took the place of the one it read", async () => {
    const cases = [
      ["browser.click", { ref: "E1" }, STAGED_HEARTH, { code: "forbidden", message: HEARTH_PAGE }],
      ["browser.choose", { ref: "E2", value: "Large" }, STAGED_HEARTH, { code: "forbidden" }],
      ["browser.click", { ref: "E1" }, STAGED_AWAY, { code: "conflict" }],
      ["browser.choose", { ref: "E2", value: "Large" }, STAGED_AWAY, { code: "conflict" }],
    ] as const;
    for (const [step, refs, there, error] of cases) {
      const { tabId } = await ok<{ tabId: number }>("browser.open", { url: START });
      const page = await ok<{ text: string }>("browser.read", { tabId });
      expect(page.text).toContain("[button E1: Go] [select E2: Size = Small]");
      let release = () => {};
      turn.held = new Promise<void>((r) => {
        release = r;
      });
      const waits = turn.waits;
      const res = t.kernel.execute(step, { tabId, ...refs }, jarvis);
      await expect.poll(() => turn.waits - waits, { timeout: 30_000 }).toBe(1);
      await chrome
        .page(tabId)
        .evaluate(`location.href = ${JSON.stringify(there)}`)
        .catch(() => {});
      await expect.poll(() => chrome.page(tabId).url(), { timeout: 30_000 }).toBe(there);
      turn.held = null;
      release();
      expect(await res).toMatchObject({ status: "error", ...error });
      expect(await chrome.page(tabId).title()).toBe("Staged");
    }
    // Nor a reference from a page gone since, whether it went by itself (yours) or Jarvis sent it.
    for (const caller of [ownerCaller(), jarvis]) {
      const { tabId } = await ok<{ tabId: number }>("browser.open", { url: START });
      await ok("browser.read", { tabId });
      if (caller === jarvis) await ok("browser.navigate", { tabId, url: STAGED_AWAY });
      else await chrome.page(tabId).goto(STAGED_AWAY);
      const res = await t.kernel.execute("browser.click", { tabId, ref: "E1" }, caller);
      expect(res).toMatchObject({ status: "error", code: "conflict" });
      expect(await chrome.page(tabId).title()).toBe("Staged");
    }
  }, 120_000);

  it("knows Hearth's own page by the mark in its head, at any address", async () => {
    const { tabId } = await ok<{ tabId: number }>("browser.open", { url: MARKED });
    await ok("browser.read", { tabId });
    const hands = [
      ["browser.click", { tabId, ref: "E1" }],
      ["browser.key", { tabId, keys: "Enter" }],
      ["browser.reject_cookies", { tabId }],
    ] as const;
    // Refused before anything asks...
    for (const [name, input] of hands)
      expect(await t.kernel.execute(name, input, jarvis)).toMatchObject({
        status: "denied",
        reason: HEARTH_PAGE,
      });
    // ...and by the step itself.
    for (const [name, input] of hands)
      expect(await t.kernel.execute(name, input, systemCaller())).toMatchObject({
        status: "error",
        code: "forbidden",
        message: HEARTH_PAGE,
      });
    expect(await chrome.page(tabId).title()).toBe("Hearth");
  });

  it("submits only with the owner's yes, and only what it said it would press", async () => {
    const { tabId } = await openShop();
    await ok("browser.type", { tabId, ref: "E6", text: "leave at door" });
    const asked = await t.kernel.execute(
      "browser.submit",
      { tabId, ref: "E8", label: "Place order", site: "shop.example" },
      jarvis,
    );
    // The kernel pins it to what it sends, so the card shows that (D58).
    expect(asked).toMatchObject({
      status: "pending_approval",
      summary: 'Press "Place order" on shop.example, sending Note: "leave at door"',
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
