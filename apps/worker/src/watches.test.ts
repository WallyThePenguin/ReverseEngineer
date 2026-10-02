import { pageWatch } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES, BROWSER_SERVICE } from "@hearth/modules";
import { FakeBrowser, instantLoads } from "@hearth/modules/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDueWatches } from "./watches.ts";

let t: TestKernel;
let chrome: FakeBrowser;
beforeEach(async () => {
  instantLoads();
  t = await createTestKernel(ALL_MODULES);
  chrome = new FakeBrowser({
    "https://a.example/": { title: "A", text: "one" },
    "https://b.example/": { title: "B", text: "two" },
  });
  t.kernel.services[BROWSER_SERVICE] = chrome;
});
afterEach(() => t.destroy());

const watch = async (url: string, everyMinutes: number) => {
  const res = await t.kernel.execute("page_watch.create", { url, everyMinutes }, ownerCaller());
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
};
const opened = () => chrome.calls.filter((c) => c.method === "tabs.open").map((c) => c.params.url);

describe("page watches in the worker", () => {
  it("checks each page when it's due, and not before", async () => {
    await watch("https://a.example/", 15);
    await watch("https://b.example/", 60);
    expect(await checkDueWatches(t.kernel)).toBe(2);
    expect(await checkDueWatches(t.kernel)).toBe(0);

    t.clock.advance(15 * 60_000);
    expect(await checkDueWatches(t.kernel)).toBe(1);
    expect(opened()).toEqual(["https://a.example/", "https://b.example/", "https://a.example/"]);

    await t.tdb.db.update(pageWatch).set({ active: false });
    t.clock.advance(60 * 60_000);
    expect(await checkDueWatches(t.kernel)).toBe(0);
  });
});
