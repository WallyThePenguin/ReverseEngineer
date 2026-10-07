// What the driver hears of a tab's page going elsewhere, and the no it gives a step that acts on a
// page on its way to Hearth's own or one it can't ask.
import { HEARTH_PAGE } from "@hearth/modules/driver-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriverContext } from "./context.ts";
import { TabState } from "./tab.ts";

const SHOP = "https://shop.example/";
const HEARTH = "https://hearth.example/approvals";

function onShop(): TabState {
  const tab = new TabState(1);
  tab.handle({
    tabId: 1,
    method: "Page.frameNavigated",
    params: { frame: { id: "F", url: SHOP } },
  });
  return tab;
}

const asks = (tab: TabState, url: string, disposition?: string) =>
  tab.handle({
    tabId: 1,
    method: "Page.frameRequestedNavigation",
    params: { frameId: "F", url, ...(disposition ? { disposition } : {}) },
  });

/** A step's context on the tab, whose page answers whether it carries Hearth's mark. */
const contextOn = (tab: TabState, marked: () => Promise<boolean>) =>
  new DriverContext({} as never, {} as never, tab, { evaluate: marked } as never, {
    owner: false,
    trusted: [],
    blocked: [],
    pace: null,
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a tab's page going elsewhere", () => {
  it("counts the pages it asks for in this tab, and where it's heading till it's there", () => {
    const tab = onShop();
    // A new tab or window, a download, or a #part of the same page: this one stays.
    asks(tab, "https://other.example/", "newTab");
    asks(tab, "https://other.example/file.zip", "download");
    asks(tab, `${SHOP}#reviews`, "currentTab");
    expect([tab.asked, tab.heading]).toEqual([0, null]);
    asks(tab, HEARTH, "currentTab");
    expect([tab.asked, tab.heading]).toEqual([1, HEARTH]);
    tab.handle({
      tabId: 1,
      method: "Page.frameNavigated",
      params: { frame: { id: "F", url: HEARTH } },
    });
    expect([tab.navigations, tab.heading]).toEqual([2, null]);
    // A page asked for that never comes (a download, a 204) is let go as loading stops.
    asks(tab, SHOP);
    expect(tab.heading).toBe(SHOP);
    tab.handle({ tabId: 1, method: "Page.frameStoppedLoading", params: { frameId: "F" } });
    expect(tab.heading).toBeNull();
  });

  it("refuses a step on a page heading to Hearth's own, or one that can't be asked", async () => {
    vi.stubEnv("HEARTH_ORIGIN", "https://hearth.example");
    const tab = onShop();
    await expect(contextOn(tab, async () => false).assertNotHearth()).resolves.toBeUndefined();
    asks(tab, HEARTH, "currentTab");
    await expect(contextOn(tab, async () => false).assertNotHearth()).rejects.toThrow(HEARTH_PAGE);
    const elsewhere = onShop();
    asks(elsewhere, "https://other.example/", "currentTab");
    await expect(
      contextOn(elsewhere, async () => false).assertNotHearth(),
    ).resolves.toBeUndefined();
    const silent = contextOn(onShop(), () => Promise.reject(new Error("gone")));
    await expect(silent.assertNotHearth()).rejects.toThrow(/couldn't tell what page/);
    await expect(contextOn(onShop(), async () => true).assertNotHearth()).rejects.toThrow(
      HEARTH_PAGE,
    );
  });
});
