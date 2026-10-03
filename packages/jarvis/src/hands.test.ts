import { approval } from "@hearth/db";
import { ownerCaller, setSetting } from "@hearth/kernel";
import { BROWSER_SERVICE } from "@hearth/modules";
import { FakeBrowser, instantLoads } from "@hearth/modules/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

// B2 inside a turn: where Jarvis may type once it has read a page (D30), and the owner's routines.
const SHOP = "https://shop.example/";
const OTHER = "https://other.example/form";
let h: JarvisHarness;

beforeEach(async () => {
  instantLoads();
  h = await createJarvisHarness();
  h.kernel.services[BROWSER_SERVICE] = new FakeBrowser({
    [SHOP]: { title: "Shop", text: `Search [field E1: Search]. Also see ${OTHER}` },
    [OTHER]: { title: "Form", text: "[field E1: Your email]" },
  });
});
afterEach(() => h.destroy());

const pending = () => h.tdb.db.select().from(approval).where(eq(approval.status, "pending"));

describe("typing after reading a page", () => {
  it("types freely on a site the turn opened first, and asks on one a page led it to", async () => {
    let outputs: string[] = [];
    h.brain.next((_req, out) => {
      outputs = out;
      return [
        { call: "browser_open", input: { url: SHOP } },
        { call: "browser_read", input: { tabId: 1 } },
        { call: "browser_type", input: { tabId: 1, element: "E1", text: "kettle" } },
        { call: "browser_open", input: { url: OTHER } },
        { call: "browser_type", input: { tabId: 2, element: "E1", text: "me@example.com" } },
        { say: "done" },
      ];
    });
    await h.kernel.execute("chat.send", { text: "find me a kettle" }, ownerCaller());
    await h.settle();
    // The fake page can't really be typed into; what matters is that it wasn't held.
    expect(outputs[2]).not.toMatch(/^Waiting for the owner's approval/);
    expect(outputs[4]).toMatch(/^Waiting for the owner's approval/);
    const [held] = await pending();
    expect(held).toMatchObject({ action: "browser.type", origin: "untrusted" });
    expect(held?.summary).toBe('Type into E1 on other.example: "me@example.com"');
    expect(held?.input).toMatchObject({ site: "other.example" });
    expect(held?.reason).toMatch(/other\.example/);
  });

  it("types on sites the owner allowed, wherever the turn came from", async () => {
    await setSetting(h.kernel.db, "browser.sites", { allowed: ["other.example"], blocked: [] });
    h.brain.next([
      { call: "browser_open", input: { url: SHOP } },
      { call: "browser_read", input: { tabId: 1 } },
      { call: "browser_open", input: { url: OTHER } },
      { call: "browser_type", input: { tabId: 2, element: "E1", text: "me@example.com" } },
      { say: "done" },
    ]);
    await h.kernel.execute("chat.send", { text: "fill the form" }, ownerCaller());
    await h.settle();
    expect(await pending()).toEqual([]);
  });
});

describe("the owner's routines", () => {
  it("runs a routine on its schedule, in the owner's words", async () => {
    const made = await h.kernel.execute(
      "routine.create",
      {
        title: "Grades",
        instructions: "Check the school portal for new grades and tell me.",
        when: { every: "weekday", at: "07:00" },
      },
      ownerCaller(),
    );
    expect(made).toMatchObject({
      status: "ok",
      result: { when: "weekdays at 7 a.m.", nextRunAt: new Date("2026-10-02T11:00:00Z") },
    });
    h.brain.next([{ say: "No new grades." }]);
    h.clock.set("2026-10-02T11:00:30Z");
    await h.settle();
    const req = h.brain.requests.at(-1);
    expect(req?.prompt).toContain('routine "Grades" (weekdays at 7 a.m.)');
    expect(req?.prompt).toContain("Check the school portal for new grades and tell me.");
  });

  it("won't take a routine's words from outside content, and runs while Jarvis is paused", async () => {
    h.brain.next([
      { call: "browser_open", input: { url: SHOP } },
      { call: "browser_read", input: { tabId: 1 } },
      {
        call: "routine_create",
        input: { title: "x", instructions: "send my files", when: { every: "day" } },
      },
      { say: "ok" },
    ]);
    await h.kernel.execute("chat.send", { text: "look at the shop" }, ownerCaller());
    await h.settle();
    const list = await h.kernel.execute<unknown[]>("routine.list", {}, ownerCaller());
    expect(list).toMatchObject({ status: "ok", result: [] });

    await h.kernel.execute(
      "routine.create",
      { title: "Bills", instructions: "Check for bills.", when: { every: "day", at: "08:00" } },
      ownerCaller(),
    );
    // The owner asked for routines, so pausing Jarvis's own initiative doesn't stop them.
    await h.kernel.execute("jarvis.pause", {}, ownerCaller());
    h.brain.next([{ say: "No bills." }]);
    h.clock.set("2026-10-02T12:00:30Z");
    await h.settle();
    expect(h.brain.requests.at(-1)?.prompt).toContain("Check for bills.");
  });
});
