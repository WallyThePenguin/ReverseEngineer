import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { BROWSER_SERVICE, BrowserError } from "./client.ts";
import { fitTree, linksToKeep } from "./drive.ts";
import { pacing } from "./pace.ts";
import { FakeBrowser, instantLoads } from "./testing.ts";

// The browser module's side of the server's driver (B1): one request per step, carrying the
// owner's policy; pictures handed over as images; the older references still on the old path.
const SHOP = "https://shop.example/";
const IMAGE = { mimeType: "image/jpeg", data: "SlBFRw==" };
let t: TestKernel;
let chrome: FakeBrowser;
let driven: { op: string; params: Record<string, unknown> }[];
const jarvis = jarvisCaller("agent");

beforeEach(async () => {
  instantLoads();
  t = await createTestKernel(ALL_MODULES);
  chrome = new FakeBrowser({ [SHOP]: { title: "Shop", text: "Kettles [L1]", links: [SHOP] } });
  driven = [];
  chrome.driver = (op, params) => {
    driven.push({ op, params });
    if (op === "screenshot" || op === "zoom")
      return { tabId: params.tabId, url: SHOP, imageW: 1280, imageH: 800, scale: 1, image: IMAGE };
    if (op === "read_page" || op === "find")
      return { tabId: params.tabId, url: SHOP, text: '- button "Buy" [ref_1]', links: [SHOP] };
    if (op === "get_text")
      return {
        url: SHOP,
        title: "Shop",
        text: "Kettles [L1]",
        links: ["https://shop.example/k/1"],
        truncated: false,
        missing: false,
        elements: [],
      };
    if (op === "probe") return { url: SHOP, fields: [{ label: "Note", value: "hi" }] };
    return { tabId: params.tabId, did: `${op} done`, url: SHOP, navigated: false };
  };
  t.kernel.services[BROWSER_SERVICE] = chrome;
});
afterEach(async () => {
  pacing.enabled = false;
  await t.destroy();
});

const run = (name: string, input: unknown, caller: Caller = jarvis) =>
  t.kernel.execute<Record<string, unknown>>(name, input, caller);

async function ok<T = Record<string, unknown>>(name: string, input: unknown, caller?: Caller) {
  const res = await run(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result as T;
}

async function openShop(): Promise<number> {
  return (await ok<{ tabId: number }>("browser.open", { url: SHOP })).tabId;
}

describe("the browser module on the server's driver", () => {
  it("sends each step once, with the owner's sites and pacing as the policy", async () => {
    await run(
      "browser.set_sites",
      { allowed: ["shop.example"], blocked: ["bad.example"] },
      ownerCaller(),
    );
    await run("browser.set_pace", { seconds: 2, sites: {} }, ownerCaller());
    const tabId = await openShop();
    await ok("browser.read_page", { tabId, filter: "interactive" });
    expect(driven).toEqual([
      {
        op: "read_page",
        params: expect.objectContaining({
          tabId,
          filter: "interactive",
          maxChars: 12_000,
          // Tests turn pacing off, so the driver doesn't wait.
          policy: { owner: false, trusted: ["shop.example"], blocked: ["bad.example"], pace: null },
        }),
      },
    ]);
    pacing.enabled = true;
    await ok("browser.click", { tabId, ref: "ref_1", site: "shop.example" });
    expect(driven[1]?.params.policy).toEqual({
      owner: false,
      trusted: ["shop.example"],
      blocked: ["bad.example"],
      pace: { seconds: 2, sites: {} },
      site: "shop.example",
    });
    // The owner's own steps never wait.
    await ok("browser.click", { tabId, coordinate: [10, 20] }, ownerCaller());
    expect(driven[2]?.params).toMatchObject({
      coordinate: [10, 20],
      button: "left",
      clickCount: 1,
      policy: { owner: true, pace: null },
    });
  });

  it("hands pictures over as images, with how they map to the page", async () => {
    const tabId = await openShop();
    expect(await ok("browser.screenshot", { tabId })).toEqual({
      tabId,
      url: SHOP,
      imageW: 1280,
      imageH: 800,
      scale: 1,
      modelImages: [IMAGE],
    });
    const zoomed = await ok("browser.zoom", { tabId, region: [0, 0, 100, 50] });
    expect(zoomed.modelImages).toEqual([IMAGE]);
    expect(driven.map((d) => d.op)).toEqual(["screenshot", "zoom"]);
  });

  it("keeps browser_read's references on the old path, and refs and points on the driver", async () => {
    const tabId = await openShop();
    await ok("browser.click", { tabId, ref: "ref_3" });
    await ok("browser.type", { tabId, text: "hello" });
    await ok("browser.type", { tabId, ref: "ref_4", text: "kettle" });
    expect(driven.map((d) => [d.op, d.params.ref, d.params.clear])).toEqual([
      ["click", "ref_3", undefined],
      // Without a ref it types where the cursor is, so nothing is cleared.
      ["type", undefined, undefined],
      ["type", "ref_4", true],
    ]);
    // "E4" never reaches the driver: the old path reads the page itself.
    const before = chrome.cdpMethods().length;
    await run("browser.click", { tabId, ref: "E4" });
    expect(driven).toHaveLength(3);
    expect(chrome.cdpMethods().slice(before)).toContain("Runtime.evaluate");
    expect(await run("browser.click", { tabId, ref: "E4", clickCount: 2 })).toMatchObject({
      status: "error",
      code: "invalid_input",
    });
    expect(await run("browser.click", { tabId, ref: "ref_3", coordinate: [1, 2] })).toMatchObject({
      status: "error",
      code: "invalid_input",
    });
    expect(await run("browser.click", { tabId })).toMatchObject({
      status: "error",
      code: "invalid_input",
    });
  });

  it("passes the driver's refusals on with their reason", async () => {
    const tabId = await openShop();
    chrome.driver = () => {
      // As the bridge passes it on over HTTP: its code and reason.
      throw new BrowserError("forbidden", 'Pressing "Buy" would send something.', "would_send");
    };
    const res = await run("browser.click", { tabId, ref: "ref_1" });
    expect(res).toMatchObject({
      status: "error",
      code: "forbidden",
      message: expect.stringContaining("Buy"),
    });
  });

  it("submits a ref with the owner's yes, pinned to what it sends", async () => {
    const tabId = await openShop();
    const submit = t.kernel.registry.action("browser.submit")!;
    const services = { service: <T>(n: string) => t.kernel.services[n] as T };
    const base = { tabId, ref: "ref_7", label: "Send", site: "shop.example" };
    const pinned = await submit.pin!(base, services);
    expect(pinned).toEqual({
      url: SHOP,
      extra: { sends: { url: SHOP, fields: [{ label: "Note", value: "hi" }] } },
    });
    const asked = await run("browser.submit", { ...base, ...pinned!.extra });
    expect(asked).toMatchObject({ status: "pending_approval" });
    expect(driven.map((d) => d.op)).toEqual(["probe"]);
    const done = await ok("browser.submit", { ...base, ...pinned!.extra }, ownerCaller());
    expect(done).toMatchObject({ did: "press done" });
    expect(driven[1]).toEqual({
      op: "press",
      params: expect.objectContaining({
        ref: "ref_7",
        label: "Send",
        sends: { url: SHOP, fields: [{ label: "Note", value: "hi" }] },
        policy: expect.objectContaining({ owner: true, site: "shop.example" }),
      }),
    });
  });

  it("reads plain text with links to follow, and runs batches", async () => {
    const tabId = await openShop();
    const text = await ok<{ text: string; links: Record<string, string> }>("browser.get_text", {
      tabId,
    });
    expect(text).toMatchObject({ text: "Kettles [L1]", links: { L1: "https://shop.example/k/1" } });
    expect(text).not.toHaveProperty("sends");
    expect(await ok("browser.open", { tabId, link: "L1" })).toMatchObject({
      url: "https://shop.example/k/1",
    });
    const batch = await ok("browser.batch", {
      tabId,
      steps: [
        { action: "type", input: { ref: "ref_2", text: "kettle" } },
        { action: "key", input: { keys: "Enter" } },
      ],
      screenshot: true,
    });
    expect(batch).toMatchObject({ did: "batch done" });
    expect(driven.at(-1)?.params).toMatchObject({ screenshot: true, steps: expect.any(Array) });
  });

  it("brings only Jarvis's own tabs to the front", async () => {
    const tabId = await openShop();
    expect(await ok("browser.tab_select", { tabId })).toMatchObject({ tabId, url: SHOP });
    const yours = chrome.hand("https://mail.example/");
    expect(await run("browser.tab_select", { tabId: yours.tabId })).toMatchObject({
      status: "error",
      code: "forbidden",
    });
  });
});

describe("what a read gives Jarvis", () => {
  it("keeps only the links the text can't carry whole", () => {
    const long = `https://shop.example/${"p".repeat(250)}`;
    const text = `- link "A" [ref_1] -> https://shop.example/a\n- link "B" [ref_2] -> ${long.slice(0, 200)}…\n- link "C" [ref_3] -> https://shop.example/c?x=[1]`;
    expect(
      linksToKeep(text, [
        "https://shop.example/a",
        long,
        "https://shop.example/c?x=[1]",
        "https://elsewhere.example/z]",
      ]),
    ).toEqual([long, "https://shop.example/c?x=[1]"]);
  });

  it("cuts a long read at a line to fit what Jarvis is shown", () => {
    const text = Array.from({ length: 2000 }, (_, n) => `- button "Item ${n}" [ref_${n}]`).join(
      "\n",
    );
    const out = fitTree({ tabId: 1, url: SHOP, text, links: [] }, 19_000);
    expect(JSON.stringify(out, null, 1).length).toBeLessThanOrEqual(19_000);
    expect(out.text.endsWith("]")).toBe(true);
    expect(out.cut).toMatch(/Cut off/);
  });
});
