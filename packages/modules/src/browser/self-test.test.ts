import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { OFFLINE_MESSAGE } from "./client.ts";
import { runSelfTest, TEST_PAGE_PATH } from "./self-test.ts";
import { FakeBrowser, instantLoads } from "./testing.ts";

// "Test Jarvis's Chrome" (D52) when things go wrong. The whole test on a real Chromium, through
// the server's driver, is in apps/server/src/browser/driver/module.test.ts.
const BASE = "https://hearth.test";
let t: TestKernel;

beforeEach(async () => {
  instantLoads();
  t = await createTestKernel(ALL_MODULES);
});
afterEach(async () => {
  await t?.destroy();
});

describe("Test Jarvis's Chrome", () => {
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
    fake.driver = (_op, p) => ({ tabId: p.tabId, url: BASE, text: "Something else", links: [] });
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
