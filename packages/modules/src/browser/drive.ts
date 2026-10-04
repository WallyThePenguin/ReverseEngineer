// Jarvis's browser through the server's driver (B1, D52). Each step is one request to the server,
// where the driver reads the page by Chrome's accessibility tree, looks, and acts by refs
// ("ref_12") or by points in the last screenshot, judging every press where it lands. The kernel
// sends the policy along with each step: the owner's blocked and trusted sites, pacing (which the
// driver waits out, next to Chrome), and the site an approved step was checked on.
import {
  type ActionContext,
  ActionError,
  defineAction,
  getSetting,
  type ModelImage,
} from "@hearth/kernel";
import { z } from "zod";
import { browser, CALLERS } from "./access.ts";
import type { DriverPolicy } from "./driver-kit.ts";
import { READ_BUDGET, readResult } from "./look.ts";
import { pacing } from "./pace.ts";
import { findTab, type PageSnapshot, rememberLinks } from "./page.ts";
import { tabId } from "./step.ts";

/** A ref from browser_read_page or browser_find. */
export const DRIVER_REF = /^ref_\d+$/;

export const driverRef = z
  .string()
  .regex(DRIVER_REF)
  .describe(
    'Something on the page, by its ref from browser_read_page or browser_find, e.g. "ref_12".',
  );

export const point = z
  .tuple([z.number().min(0), z.number().min(0)])
  .describe("A point [x, y] in the tab's last screenshot, in its pixels.");

/** What a step may do, from the owner's settings and who's asking. */
export async function policyFor(ctx: ActionContext, site?: string): Promise<DriverPolicy> {
  const owner = ctx.caller.kind === "owner";
  const sites = await getSetting(ctx.tx, "browser.sites");
  const pace = pacing.enabled && !owner ? await getSetting(ctx.tx, "browser.pace") : null;
  return {
    owner,
    trusted: sites.allowed,
    blocked: sites.blocked,
    pace,
    ...(site ? { site } : {}),
  };
}

/** One driver step: `driver.<op>` for the tab, with the step's input and the policy. */
export async function drive<T>(
  ctx: ActionContext,
  op: string,
  input: { tabId: number; site?: string | undefined } & Record<string, unknown>,
): Promise<T> {
  const { site, ...rest } = input;
  return browser(ctx).call<T>(`driver.${op}`, { ...rest, policy: await policyFor(ctx, site) });
}

/** A result's picture, moved where the model sees it as an image. */
export function withImage<T extends Record<string, unknown>>(r: T) {
  const { image, ...rest } = r as T & { image?: ModelImage };
  return image ? { ...rest, modelImages: [image] } : rest;
}

/** Characters that end an address found in text, so its exact form has to come as data. */
const AWKWARD = /[\s"'<>`\\{}|^[\]]|[.,;:!?)]$/;

/**
 * The links a read has to give as data: those shown cut short (over 200 characters) or that
 * Jarvis's check on what it may open couldn't pick out of the text whole (D25). Every other link
 * is in the text already, in full.
 */
export function linksToKeep(text: string, links: string[]): string[] {
  return links.filter((u) => (u.length > 200 || AWKWARD.test(u)) && text.includes(u.slice(0, 200)));
}

interface Tree {
  tabId: number;
  url: string;
  text: string;
  links: string[];
  cut?: string;
}

/** A read's text, cut at a line so the whole result fits what Jarvis is shown at once. */
export function fitTree<T extends Tree>(r: T, budget = READ_BUDGET) {
  let text = r.text;
  let cut = r.cut;
  for (;;) {
    const out = { ...r, text, links: linksToKeep(text, r.links), ...(cut ? { cut } : {}) };
    if (JSON.stringify(out, null, 1).length <= budget || text.length < 500) return out;
    const over = JSON.stringify(out, null, 1).length - budget;
    const end = text.lastIndexOf("\n", Math.max(0, text.length - over - 200));
    text = text.slice(0, end > 0 ? end : Math.max(0, text.length - over - 200));
    cut = 'Cut off to fit: read a part with refId, use browser_find, or filter "interactive".';
  }
}

export const READ_PAGE_DESCRIPTION =
  'Read a tab\'s page the way a screen reader does: one thing per line, indented by where it sits, like `button "Add to cart" [ref_12]`, `textbox "Search" [ref_3] value="kettle"`, `link "Next" [ref_9] -> https://…`. Pass a ref to browser_click, browser_type, browser_form_input, browser_hover, browser_scroll_to or browser_submit. Refs stay the same across reads until a new page loads. "(asks owner)" marks what would send something, so it needs browser_submit (or a site the owner trusts). filter "interactive" lists only what you can press or type into; refId reads one part. Frames from other sites are included.';

export const driveLookActions = [
  defineAction({
    name: "browser.read_page",
    description: READ_PAGE_DESCRIPTION,
    input: z.object({
      tabId,
      filter: z.enum(["all", "interactive"]).default("all"),
      depth: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("How deep to read (30 by default)."),
      refId: driverRef.optional().describe("Read only this part of the page."),
      maxChars: z.number().int().min(500).max(15_000).default(12_000),
    }),
    risk: "read",
    callers: CALLERS,
    io: true,
    external: true,
    async handler(i, ctx) {
      return fitTree(await drive<Tree & { viewport: unknown }>(ctx, "read_page", i));
    },
  }),
  defineAction({
    name: "browser.find",
    description:
      'Find things on a tab\'s page by what they say or do ("search box", "Add to cart", "price"): up to 20 matching lines from browser_read_page, with their refs.',
    input: z.object({ tabId, query: z.string().trim().min(1).max(300) }),
    risk: "read",
    callers: CALLERS,
    io: true,
    external: true,
    async handler(i, ctx) {
      return fitTree(await drive<Tree & { found: number }>(ctx, "find", i));
    },
  }),
  defineAction({
    name: "browser.get_text",
    description:
      "Read a tab's page as plain text, the way a person reads it (an article, a receipt, search results). Links show as [L4]; follow one with browser_open {tabId, link}. Long pages come in parts: pass next.offset to read on. To press or type, use browser_read_page or browser_find for refs.",
    input: z.object({
      tabId,
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(500).max(15_000).default(12_000),
    }),
    risk: "read",
    callers: CALLERS,
    io: true,
    external: true,
    async handler(i, ctx) {
      const upTo = Math.min(300_000, i.offset + i.maxChars);
      const page = await drive<PageSnapshot>(ctx, "get_text", { tabId: i.tabId, maxChars: upTo });
      rememberLinks(i.tabId, page.url, page.links);
      const { sends: _none, ...result } = readResult(i.tabId, page, i.offset, i.maxChars);
      return result;
    },
  }),
  defineAction({
    name: "browser.screenshot",
    description:
      "Look at a tab: a picture of what it shows now. Points in it are what browser_click, browser_hover, browser_drag, browser_scroll and browser_zoom take as coordinate, so you can act on what you see (a canvas, a map, something with no ref). Returns the picture's size (imageW, imageH) and how it maps to the page.",
    input: z.object({
      tabId,
      scale: z
        .number()
        .min(0.1)
        .max(1)
        .optional()
        .describe("Smaller than 1 for a smaller picture."),
    }),
    risk: "read",
    callers: CALLERS,
    io: true,
    external: true,
    async handler(i, ctx) {
      return withImage(await drive<Record<string, unknown>>(ctx, "screenshot", i));
    },
  }),
  defineAction({
    name: "browser.zoom",
    description:
      "A closer look at part of the tab's last screenshot: region [x0, y0, x1, y1] in its pixels, top left to bottom right. For small print, icons, or before clicking something tiny.",
    input: z.object({
      tabId,
      region: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0), z.number().min(0)]),
      scale: z.number().min(0.5).max(4).optional(),
    }),
    risk: "read",
    callers: CALLERS,
    io: true,
    external: true,
    async handler(i, ctx) {
      return withImage(await drive<Record<string, unknown>>(ctx, "zoom", i));
    },
  }),
  defineAction({
    name: "browser.console",
    description:
      "What Chrome logged for a tab's page (the last 200), newest last: failed requests, blocked content and other browser errors, not the page's own console.log. pattern filters them. For when a page misbehaves.",
    input: z.object({
      tabId,
      pattern: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    risk: "read",
    callers: CALLERS,
    io: true,
    external: true,
    handler: (i, ctx) => drive(ctx, "console", i),
  }),
  defineAction({
    name: "browser.tab_select",
    description:
      "Bring one of Jarvis's own tabs to the front of its window. Tabs the owner handed over stay where they put them.",
    input: z.object({ tabId }),
    risk: "internal",
    callers: CALLERS,
    io: true,
    // Titles come from the pages.
    external: true,
    async handler(i, ctx) {
      const client = browser(ctx);
      const tab = await findTab(client, i.tabId);
      if (tab.handed)
        throw new ActionError(
          "forbidden",
          `Tab ${i.tabId} is the owner's; it stays where they put it. You can still read it, look at it and act in it.`,
        );
      await client.call("tabs.show", { tabId: i.tabId });
      return { tabId: i.tabId, url: tab.url, title: tab.title };
    },
  }),
];
