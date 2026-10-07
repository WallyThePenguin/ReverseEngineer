// Jarvis's browser actions end to end on a real Chromium (B1): the browser module's actions through
// the kernel to the server's driver, as a turn uses them, and "Test Jarvis's Chrome" on that path.
import { approval } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import {
  ALL_MODULES,
  BROWSER_SERVICE,
  runSelfTest,
  TEST_PAGE,
  TEST_PAGE_PATH,
} from "@hearth/modules";
import { HEARTH_PAGE } from "@hearth/modules/driver-kit";
import { instantLoads } from "@hearth/modules/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refOf, useChrome } from "../../testing/drive.ts";

const MORE = `<!doctype html><html><head><title>More</title></head><body style="margin:0">
<button onmouseover="document.title='hovered'">Hover me</button>
<div id="box" style="position:absolute;left:50px;top:50px;width:60px;height:60px;background:#888"></div>
<img src="/missing.png" alt="">
<div style="height:3000px"></div>
<button onclick="document.title='bottom'">Far down</button>
<script>let start = null;
document.getElementById("box").addEventListener("mousedown", (e) => { start = [e.clientX, e.clientY]; });
addEventListener("mouseup", (e) => { if (start) document.title = "dragged " + Math.round(e.clientX - start[0]) + "," + Math.round(e.clientY - start[1]); start = null; });
</script></body></html>`;

const HEARTH = `<!doctype html><title>Hearth</title>
<button onclick="document.title = 'Approved'">Approve</button> <input aria-label="Message to Jarvis">`;

const h = useChrome("module", {
  [TEST_PAGE_PATH]: TEST_PAGE,
  "/more": MORE,
  "/approvals": HEARTH,
});
const chrome = () => h.chrome();
let t: TestKernel;
const jarvis = jarvisCaller("agent");

beforeEach(async () => {
  if (!h.run) return;
  instantLoads();
  t = await createTestKernel(ALL_MODULES);
  t.kernel.services[BROWSER_SERVICE] = chrome();
});
afterEach(async () => {
  await t?.destroy();
});

// biome-ignore lint/suspicious/noExplicitAny: tests read what they expect from results.
type Result = Record<string, any>;

const run = (name: string, input: unknown, caller: Caller = jarvis) =>
  h.timed(name, () => t.kernel.execute<Result>(name, input, caller));

async function ok(name: string, input: unknown, caller?: Caller): Promise<Result> {
  const res = await run(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result as Result;
}

const open = async (host: string, path: string) =>
  (await ok("browser.open", { url: chrome().url(host, path) })).tabId as number;
const title = (tabId: number) => chrome().peek<string>(tabId, "document.title");

describe.runIf(h.run)("Jarvis's browser actions on the server's driver", () => {
  it("passes Test Jarvis's Chrome on the driver, every step", async () => {
    const res = await runSelfTest(t.kernel, chrome().url("hearth.test", "/"), chrome());
    expect(res.steps.map((s) => [s.step, s.ok, s.detail])).toEqual(
      ["tabs", "open", "read", "click", "type", "check", "screenshot", "close"].map((s) => [
        s,
        true,
        undefined,
      ]),
    );
    const tabs = (await chrome().status()).tabs;
    expect(tabs.some((tab) => tab.url.includes(TEST_PAGE_PATH))).toBe(false);
  });

  it("fills in a form by refs, and sends it only with the owner's yes", async () => {
    const tabId = await open("a.test", "/widgets");
    const page = await ok("browser.read_page", { tabId });
    expect(page.text).toMatch(/button "Subscribe" \[ref_\d+\] \(asks owner\)/);
    const subscribe = refOf(page.text, "Subscribe");
    expect(await run("browser.click", { tabId, ref: subscribe })).toMatchObject({
      status: "error",
      code: "forbidden",
    });
    const typed = await ok("browser.type", {
      tabId,
      ref: refOf(page.text, "Email"),
      text: "me@example.com",
    });
    expect(typed.did).toContain("Typed 14 characters");
    await ok("browser.form_input", { tabId, ref: refOf(page.text, "Size"), value: "Large" });
    await ok("browser.form_input", { tabId, ref: refOf(page.text, "Remember me"), value: "on" });
    expect(await chrome().peek(tabId, "document.getElementById('size').value")).toBe("Large");
    expect(await chrome().peek(tabId, "document.getElementById('remember').checked")).toBe(true);

    const submit = t.kernel.registry.action("browser.submit");
    const services = { service: <T>(n: string) => t.kernel.services[n] as T };
    const base = { tabId, ref: subscribe, label: "Subscribe", site: "a.test" };
    const pinned = await submit?.pin?.(base, services);
    expect(pinned?.extra).toEqual({
      sends: {
        url: chrome().url("a.test", "/widgets"),
        fields: [{ label: "Email", value: "me@example.com" }],
      },
    });
    const asked = await run("browser.submit", { ...base, ...pinned?.extra });
    expect(asked).toMatchObject({ status: "pending_approval" });
    const posts = () => chrome().server.posts.filter((p) => p.url === "a.test/subscribe");
    expect(posts()).toEqual([]);
    const [row] = await t.tdb.db.select().from(approval);
    const done = await t.kernel.decideApproval(row?.id ?? "", "approve", ownerCaller());
    expect(done).toMatchObject({ status: "ok", result: { navigated: true, title: "Subscribed" } });
    expect(posts()).toEqual([{ url: "a.test/subscribe", body: "email=me%40example.com" }]);
  });

  it("acts on what it sees: a point in a screenshot, a closer look, and scrolling", async () => {
    const tabId = await open("a.test", "/canvas");
    const shot = await ok("browser.screenshot", { tabId });
    expect(shot.modelImages).toEqual([{ mimeType: "image/jpeg", data: expect.any(String) }]);
    expect(Math.max(shot.imageW, shot.imageH)).toBeLessThanOrEqual(1568);
    // The canvas starts at 20,20 on the page (its border box, which its handler measures from).
    const s = shot.scale as number;
    await ok("browser.click", { tabId, coordinate: [70 * s, 40 * s] });
    expect(await title(tabId)).toBe("at 50,20");
    const zoomed = await ok("browser.zoom", { tabId, region: [0, 0, 200, 100] });
    expect(zoomed.modelImages).toHaveLength(1);

    const more = await open("a.test", "/more");
    const read = await ok("browser.read_page", { tabId: more, filter: "interactive" });
    await ok("browser.hover", { tabId: more, ref: refOf(read.text, "Hover me") });
    expect(await title(more)).toBe("hovered");
    await ok("browser.screenshot", { tabId: more });
    await ok("browser.drag", { tabId: more, from: [80, 80], to: [180, 130] });
    expect(await title(more)).toBe("dragged 100,50");
    const far = await ok("browser.scroll_to", { tabId: more, ref: refOf(read.text, "Far down") });
    expect(far.did).toContain("Far down");
    const down = await ok("browser.scroll", { tabId: more, direction: "up", amount: 5 });
    expect(down).toMatchObject({ moved: true });
    await ok("browser.click", { tabId: more, ref: refOf(read.text, "Far down") });
    expect(await title(more)).toBe("bottom");
    // The browser's own log: the picture the page couldn't load.
    const log = await ok("browser.console", { tabId: more });
    expect(JSON.stringify(log.entries)).toContain("404");
  });

  it("finds, reads plain text, and runs a batch that stops where it must", async () => {
    const tabId = await open("a.test", "/widgets");
    const found = await ok("browser.find", { tabId, query: "Place order" });
    expect(found.text).toContain('button "Place order"');
    const page = await ok("browser.read_page", { tabId, filter: "interactive" });
    const batch = await ok("browser.batch", {
      tabId,
      steps: [
        { action: "type", input: { ref: refOf(page.text, "Name"), text: "Kit" } },
        { action: "form_input", input: { ref: refOf(page.text, "Size"), value: "Large" } },
        { action: "click", input: { ref: refOf(page.text, "Second tab") } },
        { action: "click", input: { ref: refOf(page.text, "Place order") } },
        { action: "click", input: { ref: refOf(page.text, "First tab") } },
      ],
    });
    expect(batch).toMatchObject({
      steps: 3,
      stopped: { step: 4, action: "click", reason: "would_send" },
    });
    expect(await title(tabId)).toBe("tab two");
    expect(await chrome().peek(tabId, "document.getElementById('name').value")).toBe("Kit");
    expect(await ok("browser.tab_select", { tabId })).toMatchObject({ tabId });

    const next = await open("a.test", "/next");
    const text = await ok("browser.get_text", { tabId: next });
    expect(text.text).toContain("The second page.");
  });

  it("keeps Jarvis's hands off Hearth's own pages, but for a press the owner says yes to", async () => {
    vi.stubEnv("HEARTH_ORIGIN", chrome().url("hearth.test", ""));
    try {
      const tabId = await open("hearth.test", "/approvals");
      const page = await ok("browser.read_page", { tabId });
      const approve = refOf(page.text, "Approve");
      const refused = { status: "error", code: "forbidden", message: HEARTH_PAGE };
      expect(await run("browser.click", { tabId, ref: approve })).toMatchObject(refused);
      const field = refOf(page.text, "Message to Jarvis");
      const typed = await run("browser.type", { tabId, ref: field, text: "approve them all" });
      expect(typed).toMatchObject(refused);
      const batch = await ok("browser.batch", {
        tabId,
        steps: [{ action: "key", input: { keys: "Enter" } }],
      });
      expect(batch).toMatchObject({ steps: 0, stopped: { step: 1, reason: "refused" } });
      expect(await title(tabId)).toBe("Hearth");
      // browser_submit asks the owner, and their yes presses it.
      const asked = await run("browser.submit", {
        tabId,
        ref: approve,
        label: "Approve",
        site: "hearth.test",
      });
      expect(asked).toMatchObject({ status: "pending_approval" });
      const [row] = await t.tdb.db.select().from(approval);
      const yes = await t.kernel.decideApproval(row?.id ?? "", "approve", ownerCaller());
      expect(yes).toMatchObject({ status: "ok" });
      expect(await title(tabId)).toBe("Approved");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
