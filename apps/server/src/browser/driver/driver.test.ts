// The driver on a real Chromium (B1): reading pages by their accessibility tree, frames from
// other sites included, and acting by refs and screenshot points, with every press judged.
import type { TabInfo } from "@hearth/modules";
import { STILL_LOADING } from "@hearth/modules/driver-kit";
import { describe, expect, it } from "vitest";
import { refOf, useChrome } from "../../testing/drive.ts";

const h = useChrome("pages");
const chrome = () => h.chrome();
const drive = h.drive;

describe.runIf(h.run)("the driver", () => {
  it("reads a page as its accessibility tree, with refs that stay the same across reads", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/"));
    const first = await drive("read_page", { tabId });
    expect(first.text).toContain('heading "Home"');
    const link = refOf(first.text, "Next page");
    const go = refOf(first.text, "Go");
    expect(first.text).toContain(
      `link "Next page" [${link}] -> ${chrome().url("a.test", "/next")}`,
    );
    expect(first.links).toContain(chrome().url("a.test", "/next"));
    const again = await drive("read_page", { tabId });
    expect(refOf(again.text, "Next page")).toBe(link);
    expect(refOf(again.text, "Go")).toBe(go);
    const only = await drive("read_page", { tabId, filter: "interactive" });
    expect(only.text).not.toContain("heading");
    expect(only.text).toContain(`button "Go" [${go}]`);
    const found = await drive("find", { tabId, query: "next page link" });
    expect(found.text.split("\n")[0]).toContain(`[${link}]`);
    const clicked = await drive("click", { tabId, ref: go });
    expect(clicked.title).toBe("clicked");
    expect(clicked.navigated).toBe(false);
    // A new page drops every ref: the old ones are gone, never something else's.
    const moved = await drive("click", { tabId, ref: link });
    expect(moved.navigated).toBe(true);
    expect(moved.title).toBe("Next");
    await expect(drive("click", { tabId, ref: go })).rejects.toMatchObject({ reason: "gone" });
    const next = await drive("read_page", { tabId });
    expect(next.text).toContain('heading "Next"');
    expect(refOf(next.text, "Back home")).not.toBe(go);
  });

  it("reads and presses inside frames from another site and from its own", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/frames"));
    const page = await drive("read_page", { tabId });
    expect(page.text).toMatch(/iframe "Far frame" \[ref_\d+\] from b\.test/);
    const inner = refOf(page.text, "Inner button");
    await drive("click", { tabId, ref: inner });
    const again = await drive("read_page", { tabId });
    expect(again.text).toContain(`button "Inner pressed" [${inner}]`);
    await drive("click", { tabId, ref: refOf(page.text, "Same site link") });
    expect((await drive("read_page", { tabId })).text).toContain('link "Same clicked"');
    // Posting a form inside the frame would send: refused by ref, and by a point on it.
    const post = refOf(page.text, "Post it");
    expect(page.text).toContain(`button "Post it" [${post}] (asks owner)`);
    await expect(drive("click", { tabId, ref: post })).rejects.toMatchObject({
      reason: "would_send",
    });
    const shot = await drive("screenshot", { tabId });
    await expect(
      drive("click", { tabId, coordinate: [60 * shot.scale, 195 * shot.scale] }),
    ).rejects.toMatchObject({ reason: "would_send" });
    expect(chrome().server.posts).toEqual([]);
    // Typing into the frame's field, by ref.
    await drive("type", { tabId, ref: refOf(page.text, "Comment"), text: "hello" });
    const typed = await drive("read_page", { tabId });
    expect(typed.text).toMatch(/textbox "Comment" \[ref_\d+\] value="hello"/);
  });

  it("presses through open shadow DOM, a hidden checkbox's label, a tab that's a link, and a parent's handler", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/widgets"));
    const page = await drive("read_page", { tabId });
    await drive("click", { tabId, ref: refOf(page.text, "Shadow button") });
    expect(await chrome().peek(tabId, "document.title")).toBe("shadow");
    const box = refOf(page.text, "Remember me");
    await drive("click", { tabId, ref: box });
    expect(await chrome().peek(tabId, `document.getElementById("remember").checked`)).toBe(true);
    const now = (await drive("read_page", { tabId })).text;
    expect(now).toMatch(
      new RegExp(`checkbox "Remember me" \\[${box}\\] \\((focused, )?checked\\)`),
    );
    const tab = refOf(page.text, "Second tab");
    expect(page.text).toContain(`tab "Second tab" [${tab}]`);
    await drive("click", { tabId, ref: tab });
    expect(await chrome().peek(tabId, "document.title")).toBe("tab two");
    // Only a pointer cursor says it's clickable; its parent handles the click.
    expect(page.text).toMatch(/clickable "Open the item" \[ref_\d+\]/);
    await drive("click", { tabId, ref: refOf(page.text, "Open the item") });
    expect(await chrome().peek(tabId, "document.title")).toBe("delegated");
  });

  it("types as keystrokes, fills a date and a list, and won't press what sends", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/widgets"));
    const page = await drive("read_page", { tabId });
    await drive("type", { tabId, ref: refOf(page.text, "Name"), text: "Ada Lovelace" });
    expect(await chrome().peek(tabId, `document.getElementById("name").value`)).toBe(
      "Ada Lovelace",
    );
    // Typing into what has focus, without a ref.
    await drive("type", { tabId, text: "!", clear: false });
    expect(await chrome().peek(tabId, `document.getElementById("name").value`)).toBe(
      "Ada Lovelace!",
    );
    await drive("form_input", { tabId, ref: refOf(page.text, "Start date"), value: "2026-10-04" });
    expect(await chrome().peek(tabId, `document.getElementById("date").value`)).toBe("2026-10-04");
    const size = await drive("form_input", {
      tabId,
      ref: refOf(page.text, "Size"),
      value: "large",
    });
    expect(size.now).toBe("= Large");
    // A form that posts: its button, and Enter in its field, ask the owner first.
    const order = refOf(page.text, "Place order");
    expect(page.text).toContain(`button "Place order" [${order}] (asks owner`);
    await expect(drive("click", { tabId, ref: order })).rejects.toMatchObject({
      reason: "would_send",
    });
    await drive("type", { tabId, ref: refOf(page.text, "Note"), text: "hi" });
    await expect(drive("key", { tabId, keys: "Enter" })).rejects.toMatchObject({
      reason: "would_send",
    });
    expect(chrome().server.posts).toEqual([]);
  });

  it("clicks a canvas by a point in the screenshot, and zooms in", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/canvas"));
    const shot = await drive("screenshot", { tabId });
    expect(shot.image.mimeType).toBe("image/jpeg");
    expect(Math.max(shot.imageW, shot.imageH)).toBeLessThanOrEqual(1568);
    expect(shot.imageW).toBe(Math.round(shot.cssW * shot.scale));
    expect(shot).toMatchObject({ dpr: 1, scrollX: 0, scrollY: 0 });
    // The canvas starts at 20,20 (its margin): click 50,40 inside it.
    await drive("click", { tabId, coordinate: [(20 + 50) * shot.scale, (20 + 40) * shot.scale] });
    expect(await chrome().peek(tabId, "document.title")).toBe("at 50,40");
    const zoomed = await drive("zoom", { tabId, region: [0, 0, 100, 50] });
    expect(zoomed.image.mimeType).toBe("image/png");
    expect(zoomed.imageW).toBeGreaterThan(100);
  });
});

describe.runIf(h.run)("a read of a page still loading", () => {
  // A page can move on after browser.open's wait (a script sends it elsewhere, or a click starts
  // a page later than a step waits for). A read that lands while that page is still coming says
  // so first, so Jarvis doesn't act on part of the page, or none of it, without knowing.
  it("says the page is still loading till it has, and nothing of it after", async () => {
    const tabId = await chrome().open(chrome().url("a.test", "/"));
    const tab = async () =>
      (await chrome().call<TabInfo[]>("tabs.list")).find((t) => t.tabId === tabId);
    await chrome().call("cdp", {
      tabId,
      method: "Page.navigate",
      params: { url: chrome().url("a.test", "/unfinished") },
    });
    // Its first part is in once the new page has parsed it; the rest waits for finish().
    await expect
      .poll(() => chrome().peek<string>(tabId, `document.body?.innerText ?? ""`))
      .toContain("The start");
    expect((await tab())?.loading).toBe(true);
    const early = await drive("read_page", { tabId });
    expect(early.loading).toBe(true);
    expect(early.text.split("\n")[0]).toBe(STILL_LOADING);
    expect(early.text).toContain("The start");
    expect(early.text).not.toContain("The end");
    const found = await drive("find", { tabId, query: "start" });
    expect(found.loading).toBe(true);
    expect(found.text.split("\n")[0]).toBe(STILL_LOADING);
    expect(await drive("get_text", { tabId })).toMatchObject({ loading: true, text: "The start" });

    chrome().server.finish();
    await expect.poll(() => chrome().peek(tabId, "document.readyState")).toBe("complete");
    await expect.poll(async () => (await tab())?.loading).toBe(false);
    const late = await drive("read_page", { tabId });
    expect(late.loading).toBeUndefined();
    expect(late.text).toContain('heading "The end"');
    expect(late.text).not.toContain(STILL_LOADING);
    expect((await drive("find", { tabId, query: "end" })).loading).toBeUndefined();
    expect((await drive("get_text", { tabId })).loading).toBeUndefined();
  });
});

describe.runIf(h.run)("the tests' Chrome", () => {
  // The tests' open waits for a page to load, as browser.open does before Jarvis reads it (B1).
  // It once gave up after a set number of checks and handed over a tab whose first read came
  // back empty, the way a tab still on its blank page reads. The test has a minute: its four new
  // tabs and two pages that take 2.5 s each went past the usual 20 s under load.
  it("hands over a tab once its page has loaded, and fails by name when it doesn't", async () => {
    // Nothing comes for 2.5 s: the tab is still on its blank page when the wait runs out.
    const held = chrome().url("a.test", "/held");
    await expect(chrome().open(held, false, 250)).rejects.toThrow(
      `${held} didn't load in 0.25 s: it's still "blank".`,
    );
    // Its heading comes 2.5 s after the rest. The wait starts before Page.navigate, so a late
    // answer can't stretch it till the page is done.
    const slow = chrome().url("a.test", "/slow");
    await expect(chrome().open(slow, false, 250)).rejects.toThrow(`${slow} didn't load in 0.25 s`);
    // With the usual wait, the first read shows each page. Each is asked for afresh, since Chrome
    // held a second request for /held till the first one's answer came.
    const first = await chrome().open(`${held}?again`);
    expect((await drive("read_page", { tabId: first })).text).toContain('heading "Held"');
    const second = await chrome().open(`${slow}?again`);
    expect((await drive("read_page", { tabId: second })).text).toContain('heading "Slow"');
  }, 60_000);
});
