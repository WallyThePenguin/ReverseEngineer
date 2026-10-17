// Reading a page in your Chrome as text, the way a person reads it, with the older references
// ("E4") the hands in act.ts still take; browser_read_page, browser_get_text and the screenshot
// come from the server's driver (drive.ts). Pages are outside content, so reading one makes the
// rest of a turn untrusted (D25).
import { defineAction } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import { findTab, type PageSnapshot, readPage, rememberDoc, rememberLinks } from "./page.ts";

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

export const lookActions = [
  defineAction({
    name: "browser.read",
    description:
      "The older reader, for when browser_read_page or browser_get_text fails on a page. Reads the page in a tab as text, the way a person sees it. Links show as references like [L4]; follow one with browser_open {tabId, link}. Things you can press or type into show as [button E3: Add to cart], [field E5: Search] and so on: use browser_click, browser_type, browser_choose and browser_submit with them. `sends` lists the ones that would send something. Long pages come in parts: pass next.offset to read on.",
    input: z.object({
      tabId: z.number().int(),
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(500).max(15_000).default(12_000),
    }),
    risk: "read",
    callers: CALLERS,
    io: true,
    external: true,
    async handler(i, ctx) {
      const client = browser(ctx);
      await assertAllowed(ctx, (await findTab(client, i.tabId)).url);
      const upTo = Math.min(MAX_READ, i.offset + i.maxChars);
      const page = await readPage(client, i.tabId, upTo, undefined, true);
      // The page may have moved on since the tab list was read.
      await assertAllowed(ctx, page.url);
      rememberLinks(i.tabId, page.url, page.links, page.elements);
      rememberDoc(i.tabId, page.doc);
      return readResult(i.tabId, page, i.offset, i.maxChars);
    },
  }),
];
