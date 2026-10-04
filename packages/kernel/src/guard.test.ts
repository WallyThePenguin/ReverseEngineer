// D25/D30 in the kernel (D58): every call made as Jarvis, not only a turn's tool calls, is checked
// against the page it opens or acts on and captures what it will send before it runs or waits.
import { approval, audit } from "@hearth/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { jarvisCaller, ownerCaller } from "./callers.ts";
import { ActionError } from "./errors.ts";
import { setSetting } from "./settings.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";
import { defineAction, defineModule } from "./types.ts";

const pages = new Map<number, string>();
const letters = new Map<string, string>();

const probe = defineModule({
  name: "probe",
  description: "Test module",
  entityTypes: [],
  events: [],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    defineAction({
      name: "probe.open",
      description: "Opens a page",
      input: z.object({ url: z.string() }),
      risk: "read",
      opensUrl: (i) => i.url,
      handler: async (i) => ({ opened: i.url }),
    }),
    defineAction({
      name: "probe.click",
      description: "Clicks in a tab",
      input: z.object({ tab: z.number(), site: z.string().optional(), at: z.string().optional() }),
      risk: "internal",
      async pin(i, services) {
        const url = services.service<Map<number, string>>("pages").get(i.tab);
        return url ? { url, extra: { at: "pinned" } } : null;
      },
      handler: async (i) => i,
    }),
    defineAction({
      name: "probe.mail",
      description: "Sends a letter",
      input: z.object({ id: z.string(), snapshot: z.object({ text: z.string() }).optional() }),
      risk: "outward",
      async snapshot(i) {
        const text = letters.get(i.id);
        if (!text) throw new ActionError("not_found", "No letter with that id.");
        return { snapshot: { text } };
      },
      summarize: (i) => `Send "${i.snapshot?.text ?? "?"}"`,
      handler: async (i) => ({ sent: i.snapshot?.text }),
    }),
    defineAction({
      name: "probe.wrap",
      description: "Opens a page from inside another action",
      input: z.object({ url: z.string() }),
      risk: "read",
      handler: (i, ctx) => ctx.call("probe.open", i),
    }),
  ],
});

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([probe]);
  t.kernel.services.pages = pages;
});
afterAll(() => t.destroy());
beforeEach(async () => {
  await t.tdb.db.delete(approval);
  pages.clear();
  letters.clear();
  await setSetting(t.kernel.db, "browser.sites", {
    allowed: ["calm.example"],
    blocked: ["bank.example"],
  });
});

describe("Jarvis's calls in the kernel (D58)", () => {
  it("holds a call made from outside content to D25 even without a turn, as a reflex's is", async () => {
    const outside = jarvisCaller("untrusted");
    const unseen = await t.kernel.execute(
      "probe.open",
      { url: "https://evil.example/?d=1" },
      outside,
    );
    expect(unseen).toMatchObject({
      status: "pending_approval",
      reason: expect.stringMatching(/didn't appear in it/),
    });
    // An address the content showed, or a site you allowed, opens; a blocked site never does.
    const seen = { ...outside, trust: { seenUrls: new Set(["https://news.example/a"]) } };
    expect(await t.kernel.execute("probe.open", { url: "https://news.example/a" }, seen)).toEqual({
      status: "ok",
      result: { opened: "https://news.example/a" },
    });
    expect(await t.kernel.execute("probe.open", { url: "https://calm.example/" }, outside)).toEqual(
      { status: "ok", result: { opened: "https://calm.example/" } },
    );
    const trusted = jarvisCaller("agent");
    const blocked = await t.kernel.execute("probe.open", { url: "https://bank.example/" }, trusted);
    expect(blocked).toMatchObject({
      status: "denied",
      reason: expect.stringMatching(/never opens/),
    });
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "probe.open"));
    expect(rows.map((r) => r.outcome)).toContain("denied");
    // You aren't held to any of it.
    expect(
      await t.kernel.execute("probe.open", { url: "https://bank.example/" }, ownerCaller()),
    ).toMatchObject({ status: "ok" });
  });

  it("pins acting to its page, so a yes given later runs what was checked (D30)", async () => {
    pages.set(1, "https://shop.example/cart");
    const outside = jarvisCaller("untrusted");
    const asked = await t.kernel.execute("probe.click", { tab: 1 }, outside);
    expect(asked).toMatchObject({
      status: "pending_approval",
      reason: expect.stringMatching(/went to shop\.example/),
    });
    const [row] = await t.tdb.db.select().from(approval);
    expect(row?.input).toEqual({ tab: 1, site: "shop.example", at: "pinned" });

    // A site the turn opened before it read anything is fine; the pin still goes on.
    const vouched = {
      ...outside,
      trust: { seenUrls: new Set<string>(), vouchedHosts: new Set(["shop.example"]) },
    };
    expect(await t.kernel.execute("probe.click", { tab: 1 }, vouched)).toEqual({
      status: "ok",
      result: { tab: 1, site: "shop.example", at: "pinned" },
    });
    // Nowhere to pin it: a trusted call runs, one from outside content asks.
    expect(await t.kernel.execute("probe.click", { tab: 9 }, jarvisCaller("agent"))).toEqual({
      status: "ok",
      result: { tab: 9 },
    });
    expect(await t.kernel.execute("probe.click", { tab: 9 }, outside)).toMatchObject({
      status: "pending_approval",
      reason: "Hearth couldn't tell which site this would act on.",
    });
  });

  it("takes the snapshot itself, so the card shows what goes out whoever asked", async () => {
    letters.set("a", "See you Friday");
    const forged = { id: "a", snapshot: { text: "Nothing to see" } };
    const asked = await t.kernel.execute("probe.mail", forged, jarvisCaller("agent"));
    expect(asked).toMatchObject({ status: "pending_approval", summary: 'Send "See you Friday"' });
    const [row] = await t.tdb.db.select().from(approval);
    expect(row?.input).toEqual({ id: "a", snapshot: { text: "See you Friday" } });
    // One it can't take is an error, before anything waits for you.
    expect(await t.kernel.execute("probe.mail", { id: "b" }, jarvisCaller("agent"))).toEqual({
      status: "error",
      code: "not_found",
      message: "No letter with that id.",
    });
    expect(await t.tdb.db.select().from(approval)).toHaveLength(1);
  });

  it("won't let Jarvis reach a checked action from inside another one", async () => {
    const url = { url: "https://calm.example/" };
    expect(await t.kernel.execute("probe.wrap", url, jarvisCaller("agent"))).toMatchObject({
      status: "error",
      code: "forbidden",
    });
    expect(await t.kernel.execute("probe.wrap", url, ownerCaller())).toMatchObject({
      status: "ok",
    });
  });
});
