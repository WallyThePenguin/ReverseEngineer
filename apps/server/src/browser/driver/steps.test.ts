// The driver's steps on a real Chromium (B1): pop-ups, an endless list, what covers a ref, a
// dialog in the way, trusted sites, what a page made clickable itself, one step at a time per
// tab, and batches that stop at the first step that fails, on another site, or out of time.
import { describe, expect, it } from "vitest";
import { refOf, useChrome } from "../../testing/drive.ts";
import { BATCH_MS } from "./driver.ts";

const h = useChrome("steps");
const chrome = () => h.chrome();
const drive = h.drive;

describe.runIf(h.run)("the driver's steps", () => {
  it("says which tab a pop-up opened, and scrolls an endless list", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/widgets"));
    const page = await drive("read_page", { tabId });
    const opened = await drive("click", { tabId, ref: refOf(page.text, "Open pop-up") });
    const popup = opened.opened?.[0]?.tabId;
    expect(popup).toBeTypeOf("number");
    const urlOf = async () =>
      (await chrome().call<{ tabId: number; url: string }[]>("tabs.list")).find(
        (t) => t.tabId === popup,
      )?.url;
    await expect.poll(urlOf).toContain("/next");

    const feed = await chrome().open(chrome().url("a.test", "/endless"));
    const count = () => chrome().peek<number>(feed, "document.querySelectorAll('#feed p').length");
    const before = await count();
    const first = await drive("scroll", { tabId: feed, direction: "down", amount: 10 });
    expect(first.moved).toBe(true);
    await drive("scroll", { tabId: feed, direction: "down", amount: 10 });
    expect(await count()).toBeGreaterThan(before);
  });

  it("says what covers a ref, and stops at a dialog", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/covered"));
    const page = await drive("read_page", { tabId });
    await expect(
      drive("click", { tabId, ref: refOf(page.text, "Hidden under") }),
    ).rejects.toMatchObject({
      reason: "covered",
    });
    expect(await chrome().peek(tabId, "document.title")).toBe("Covered");

    const w = await chrome().open(chrome().url("a.test", "/widgets"));
    const wp = await drive("read_page", { tabId: w });
    const alerted = await drive("click", { tabId: w, ref: refOf(wp.text, "Show alert") });
    expect(alerted.dialog?.type).toBe("alert");
    await expect(drive("click", { tabId: w, ref: refOf(wp.text, "Name") })).rejects.toMatchObject({
      reason: "dialog_open",
    });
    await chrome().call("cdp", {
      tabId: w,
      method: "Page.handleJavaScriptDialog",
      params: { accept: true },
    });
  });

  it("presses what sends on a site the owner trusts, and never on a blocked one", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/widgets"));
    const page = await drive("read_page", { tabId });
    const policy = { owner: false, trusted: ["a.test"], blocked: [], pace: null };
    // Placing an order is the floor: it asks even here.
    await expect(
      drive("click", { tabId, ref: refOf(page.text, "Place order"), policy }),
    ).rejects.toMatchObject({
      reason: "would_send",
    });
    const sent = await drive("click", { tabId, ref: refOf(page.text, "Subscribe"), policy });
    expect(sent).toMatchObject({ navigated: true, title: "Subscribed" });
    expect(chrome().server.posts.map((p) => p.url)).toEqual(["a.test/subscribe"]);
    const blocked = { owner: false, trusted: [], blocked: ["a.test"], pace: null };
    await expect(drive("read_page", { tabId, policy: blocked })).rejects.toMatchObject({
      reason: "blocked",
    });
  });

  it("judges what a page made clickable by its name, by ref and by a point on it", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/clickables"));
    const page = await drive("read_page", { tabId });
    const del = refOf(page.text, "Delete account");
    expect(page.text).toContain(`clickable "Delete account" [${del}] (asks owner: account)`);
    expect(page.text).toMatch(/clickable "Publish" \[ref_\d+\] \(asks owner\)/);
    await expect(drive("click", { tabId, ref: del })).rejects.toMatchObject({
      reason: "would_send",
    });
    // A point on a word inside it is judged as the whole thing.
    const shot = await drive("screenshot", { tabId });
    const [x, y] = await chrome().peek<[number, number]>(
      tabId,
      `(() => { const r = document.querySelector("#del span").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`,
    );
    await expect(
      drive("click", { tabId, coordinate: [x * shot.scale, y * shot.scale] }),
    ).rejects.toMatchObject({ reason: "would_send" });
    expect(await chrome().peek(tabId, "document.title")).toBe("Clickables");
    // On a site the owner trusts, "Publish" goes ahead; the floor still asks.
    const policy = { owner: false, trusted: ["a.test"], blocked: [], pace: null };
    await drive("click", { tabId, ref: refOf(page.text, "Publish"), policy });
    expect(await chrome().peek(tabId, "document.title")).toBe("pub");
    await expect(drive("click", { tabId, ref: del, policy })).rejects.toMatchObject({
      reason: "would_send",
    });
    // What doesn't send is free anywhere.
    await drive("click", { tabId, ref: refOf(page.text, "Show details") });
    expect(await chrome().peek(tabId, "document.title")).toBe("more");
  });

  it("waits out the site's pace after a page loads, as after any other step", async () => {
    const started = Date.now();
    const tabId = await chrome().open(chrome().url("a.test", "/"));
    const page = await drive("read_page", { tabId });
    const policy = { owner: false, trusted: [], blocked: [], pace: { seconds: 1, sites: {} } };
    await drive("click", { tabId, ref: refOf(page.text, "Go"), policy });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(await chrome().peek(tabId, "document.title")).toBe("clicked");
  });

  it("takes one tab's steps one at a time, so two at once don't type into each other", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/widgets"));
    const page = await drive("read_page", { tabId });
    await Promise.all([
      drive("type", { tabId, ref: refOf(page.text, "Name"), text: "aaaaaaaaaa" }),
      drive("type", { tabId, ref: refOf(page.text, "Note"), text: "bbbbbbbbbb" }),
    ]);
    expect(await chrome().peek(tabId, `document.getElementById("name").value`)).toBe("aaaaaaaaaa");
    expect(await chrome().peek(tabId, `document.querySelector("[name=note]").value`)).toBe(
      "bbbbbbbbbb",
    );
  });

  it("stops a batch once a step takes the tab to another site, or it runs out of time", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/clickables"));
    const page = await drive("read_page", { tabId });
    const away = await drive("batch", {
      tabId,
      steps: [
        { action: "click", input: { ref: refOf(page.text, "Elsewhere") } },
        { action: "key", input: { keys: "Tab" } },
      ],
    });
    expect(away).toMatchObject({
      steps: 1,
      url: expect.stringContaining("b.test"),
      stopped: { step: 2, action: "key", reason: "changed" },
    });
    chrome().driver.batchMs = 100;
    try {
      const slow = await drive("batch", {
        tabId,
        steps: [
          { action: "wait", input: { ms: 150 } },
          { action: "wait", input: { ms: 10 } },
        ],
      });
      expect(slow).toMatchObject({ steps: 1, stopped: { step: 2, reason: "timeout" } });
    } finally {
      chrome().driver.batchMs = BATCH_MS;
    }
  });

  it("runs a batch of steps in order and stops at the first that fails", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/widgets"));
    const page = await drive("read_page", { tabId });
    const out = await drive("batch", {
      tabId,
      steps: [
        { action: "type", input: { ref: refOf(page.text, "Name"), text: "Grace" } },
        { action: "form_input", input: { ref: refOf(page.text, "Size"), value: "Large" } },
        { action: "click", input: { ref: refOf(page.text, "Place order") } },
        { action: "type", input: { ref: refOf(page.text, "Note"), text: "never" } },
      ],
    });
    expect(out.steps).toBe(2);
    expect(out.stopped).toMatchObject({ step: 3, action: "click", reason: "would_send" });
    expect(await chrome().peek(tabId, `document.getElementById("name").value`)).toBe("Grace");
    expect(await chrome().peek(tabId, `document.querySelector("[name=note]").value`)).toBe("");
  });
});
