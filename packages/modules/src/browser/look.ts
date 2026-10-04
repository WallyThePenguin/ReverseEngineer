// Looking at a page in your Chrome: as text, the way a person reads it, or as a picture. Pages are
// outside content, so both make the rest of a turn untrusted (D25).
import { defineAction, type ModelImage } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import type { BrowserClient } from "./client.ts";
import { findTab, type PageSnapshot, readPage, rememberLinks } from "./page.ts";

/** The most of a page read at once; longer pages are cut off there. */
const MAX_READ = 300_000;

/** What Jarvis is shown of one read at most, with room to spare under its 20,000 characters. */
export const READ_BUDGET = 19_000;

/**
 * One part of a page as Jarvis gets it: where to read on and what would send before the text,
 * so a long page can't push them out of sight, and only the links the part mentions.
 */
export function readResult(
  tabId: number,
  page: PageSnapshot,
  offset: number,
  maxChars: number,
  budget = READ_BUDGET,
) {
  let take = maxChars;
  for (;;) {
    const text = page.text.slice(offset, offset + take);
    const refs = [...new Set([...text.matchAll(/\[L(\d+)\]/g)].map((m) => Number(m[1])))];
    const shown = new Set([...text.matchAll(/ (E\d+): /g)].map((m) => m[1]));
    const end = offset + text.length;
    const more = page.truncated || end < page.text.length;
    const result = {
      tabId,
      url: page.url,
      title: page.title,
      next: more && end < MAX_READ ? { offset: end } : null,
      sends: page.elements
        .filter((e) => e.submits && shown.has(e.ref))
        .map((e) => `${e.ref} ${e.label}`),
      links: Object.fromEntries(
        refs.flatMap((n) => (page.links[n - 1] ? [[`L${n}`, page.links[n - 1]]] : [])),
      ) as Record<string, string>,
      text,
    };
    const size = JSON.stringify(result, null, 1).length;
    if (size <= budget || take <= 500) return result;
    take = Math.max(500, take - (size - budget) - 200);
  }
}

/** The size of what a tab shows, in the screenshot's pixels, and the page's zoom to get there. */
export async function viewport(client: BrowserClient, tabId: number) {
  const m = await client
    .call<{
      cssVisualViewport?: {
        clientWidth: number;
        clientHeight: number;
        pageX: number;
        pageY: number;
      };
      visualViewport?: { clientWidth: number; clientHeight: number };
      cssContentSize?: { width: number; height: number };
    }>("cdp", { tabId, method: "Page.getLayoutMetrics", params: {} })
    .catch(() => null);
  const css = m?.cssVisualViewport;
  if (!css?.clientWidth) return null;
  const scale = (m?.visualViewport?.clientWidth ?? css.clientWidth) / css.clientWidth || 1;
  return {
    css,
    scale,
    width: Math.round(css.clientWidth * scale),
    height: Math.round(css.clientHeight * scale),
    content: m?.cssContentSize ?? null,
  };
}

export const lookActions = [
  defineAction({
    name: "browser.read",
    description:
      "Read the page in a tab as text, the way a person sees it. Links show as references like [L4]; follow one with browser_open {tabId, link}. Things you can press or type into show as [button E3: Add to cart], [field E5: Search] and so on: use browser_click, browser_type, browser_choose and browser_submit with them. `sends` lists the ones that would send something. Long pages come in parts: pass next.offset to read on.",
    input: z.object({
      tabId: z.number().int(),
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(500).max(15_000).default(12_000),
    }),
    risk: "read",
    callers: CALLERS,
    external: true,
    async handler(i, ctx) {
      const client = browser(ctx);
      await assertAllowed(ctx, (await findTab(client, i.tabId)).url);
      const upTo = Math.min(MAX_READ, i.offset + i.maxChars);
      const page = await readPage(client, i.tabId, upTo, undefined, true);
      // The page may have moved on since the tab list was read.
      await assertAllowed(ctx, page.url);
      rememberLinks(i.tabId, page.url, page.links, page.elements);
      return readResult(i.tabId, page, i.offset, i.maxChars);
    },
  }),
  defineAction({
    name: "browser.screenshot",
    description:
      "Look at a tab: a picture of what it shows now, and its size in pixels. Use it when the page's look matters (a chart, a layout, a captcha) or reading it as text wasn't enough.",
    input: z.object({ tabId: z.number().int() }),
    risk: "read",
    callers: CALLERS,
    external: true,
    async handler(i, ctx) {
      const client = browser(ctx);
      const tab = await findTab(client, i.tabId);
      await assertAllowed(ctx, tab.url);
      // Chrome only draws the tab showing in its window.
      if (!tab.handed) await client.call("tabs.show", { tabId: i.tabId });
      const size = await viewport(client, i.tabId);
      const shot = await client.call<{ data: string }>("cdp", {
        tabId: i.tabId,
        method: "Page.captureScreenshot",
        params: { format: "jpeg", quality: 60 },
      });
      const modelImages: ModelImage[] = [{ mimeType: "image/jpeg", data: shot.data }];
      return {
        tabId: i.tabId,
        url: tab.url,
        ...(size ? { width: size.width, height: size.height } : {}),
        modelImages,
      };
    },
  }),
];
