import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { ChromiumBrowser, chromiumForTests } from "./chromium.ts";
import { OFFLINE_MESSAGE } from "./client.ts";
import { pacing } from "./pace.ts";
import { loadTiming } from "./page.ts";
import { runSelfTest, TEST_PAGE, TEST_PAGE_PATH } from "./self-test.ts";
import { FakeBrowser } from "./testing.ts";

// "Test Jarvis's Chrome" (D52), on Hearth's own test page in real Chromium.
const BASE = "https://hearth.test";
const hasChromium = chromiumForTests();
let t: TestKernel;
let chrome: ChromiumBrowser;

beforeAll(async () => {
  if (hasChromium)
    chrome = await ChromiumBrowser.launch({ [`${BASE}${TEST_PAGE_PATH}`]: TEST_PAGE });
});
afterAll(async () => {
  await chrome?.close();
});
beforeEach(async () => {
  Object.assign(loadTiming, { startMs: 250, pollMs: 50, settleMs: 50 });
  pacing.enabled = false;
  t = await createTestKernel(ALL_MODULES);
});
afterEach(async () => {
  await t?.destroy();
});

describe("Test Jarvis's Chrome", () => {
  it.skipIf(!hasChromium)("passes every step, timed, and closes its tab", async () => {
    const res = await runSelfTest(t.kernel, `${BASE}/`, chrome);
    expect(res.steps.map((s) => [s.step, s.ok, s.detail])).toEqual(
      ["tabs", "open", "read", "click", "type", "check", "screenshot", "close"].map((s) => [
        s,
        true,
        undefined,
      ]),
    );
    expect(res.ok).toBe(true);
    for (const s of res.steps) expect(s.ms).toBeGreaterThanOrEqual(0);
    expect(res.steps[0]?.label).toBe("See Chrome's tabs");
    expect(await chrome.status()).toMatchObject({ tabs: [] });
  });

  it("stops at the first step that fails, and says why plainly", async () => {
    const offline = new FakeBrowser();
    offline.connected = false;
    const res = await runSelfTest(t.kernel, BASE, offline);
    expect(res.ok).toBe(false);
    expect(res.steps).toEqual([
      expect.objectContaining({ step: "tabs", ok: true }),
      expect.objectContaining({ step: "open", ok: false, detail: OFFLINE_MESSAGE }),
    ]);
  });

  it("closes the tab even when a later step fails", async () => {
    const fake = new FakeBrowser({
      [`${BASE}${TEST_PAGE_PATH}`]: { title: "Not the test page", text: "Something else" },
    });
    const res = await runSelfTest(t.kernel, BASE, fake);
    expect(res.steps.map((s) => [s.step, s.ok])).toEqual([
      ["tabs", true],
      ["open", true],
      ["read", false],
      ["close", true],
    ]);
    expect(res.steps[2]?.detail).toBe("The test page didn't read as expected.");
    expect(fake.tabs).toEqual([]);
  });
});
