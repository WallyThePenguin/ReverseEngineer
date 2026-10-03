// Jarvis's browser (D24, D25): open pages in your own Chrome, read them, look at them, and close
// them again (step 1); click, type, submit with your yes, and sign in from the vault (step 2,
// act.ts, sign-in.ts). It works in Jarvis's own window and in tabs you hand it. Pages are
// outside content, so reading one makes the rest of a turn untrusted. Sites on your blocked list
// are off limits to everyone but you.
import {
  ActionError,
  defineAction,
  defineModule,
  getSetting,
  type ModelImage,
  setSetting,
} from "@hearth/kernel";
import { z } from "zod";
import { notesForSite } from "../memory/recall.ts";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import { actActions } from "./act.ts";
import type { TabInfo } from "./client.ts";
import { pace } from "./pace.ts";
import { findTab, forgetLinks, linkUrl, readPage, rememberLinks, waitForLoad } from "./page.ts";
import { signInAction } from "./sign-in.ts";
import { vaultActions } from "./vault.ts";
import { describeWatch, watchActions, watchFollowUp } from "./watches.ts";

/** The most of a page read at once; longer pages are cut off there. */
const MAX_READ = 300_000;

/** A site as written in the lists: a host name like "bank.example", subdomains included. */
const SITE = z
  .string()
  .trim()
  .regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "Write a site as a host name, like bank.example.");

const OpenInput = z.object({
  url: z.string().max(4000).optional().describe("The address to open."),
  link: z
    .string()
    .regex(/^L\d+$/)
    .optional()
    .describe('A link from the page last read in tabId, by its reference, e.g. "L4".'),
  tabId: z
    .number()
    .int()
    .optional()
    .describe("Open it in this tab. Without one, a new tab opens in Jarvis's window."),
  newTab: z.boolean().default(false).describe("Open a link in a new tab instead of tabId."),
});
type OpenInput = z.output<typeof OpenInput>;

function target(i: OpenInput): string | null {
  if (i.link) return i.tabId === undefined ? null : linkUrl(i.tabId, i.link);
  return i.url ?? null;
}

export const browserModule = defineModule({
  name: "browser",
  description:
    "Your own Chrome, through the Hearth extension: Jarvis's window and the tabs you hand it.",
  entityTypes: ["page_watch"],
  // A watch keeps the page's text, which came from the web.
  outsideTypes: ["page_watch"],
  events: [
    { kind: "browser.opened", description: "Jarvis opened a page. Payload: tabId, url." },
    {
      kind: "browser.closed",
      description: "Jarvis closed its tab, or gave yours back. Payload: tabId, handedBack.",
    },
    {
      kind: "page_watch.changed",
      description:
        "A watched page changed. Payload: url, title, followUp (whether the watch says what to do).",
    },
    {
      kind: "page_watch.failing",
      description: "A watched page couldn't be checked several times in a row. Payload: url.",
    },
    {
      kind: "browser.sites_changed",
      description: "You changed the sites Jarvis may open freely or never opens. Payload: sites.",
    },
    {
      kind: "browser.signed_in",
      description:
        "Jarvis signed in to a site from the vault, or tried to. Payload: site, username, status.",
    },
    {
      kind: "vault.changed",
      description: "You saved, changed or removed a sign-in. Payload: site, username, removed.",
    },
  ],
  knowledge: { page_watch: describeWatch },
  reflexes: [watchFollowUp],
  actions: [
    ...watchActions,
    ...actActions,
    ...vaultActions,
    signInAction,
    defineAction({
      name: "browser.tabs",
      description:
        "List the Chrome tabs Jarvis may use (its own window, and tabs the owner handed it), and whether Chrome is connected.",
      input: z.object({}),
      risk: "read",
      callers: CALLERS,
      // Titles come from the pages themselves.
      external: true,
      async handler(_i, ctx) {
        const status = await browser(ctx).status();
        return {
          connected: status.connected,
          tabs: status.tabs.map((t) => ({
            tabId: t.tabId,
            url: t.url,
            title: t.title,
            yours: t.handed,
            loading: t.loading,
          })),
        };
      },
    }),
    defineAction({
      name: "browser.open",
      description:
        "Open a web page in the owner's Chrome, signed in as them: an address, or a link from a page you read (by its reference, with tabId). Returns the tab, and what you remember about the site (siteNotes); read the page with browser_read.",
      input: OpenInput,
      risk: "read",
      callers: CALLERS,
      opensUrl: target,
      summarize: (i) => `Open ${target(i) ?? i.link ?? "a page"} in Chrome`,
      async handler(i, ctx) {
        if (!i.url === !i.link)
          throw new ActionError("invalid_input", "Give either a url or a link reference.");
        const raw = target(i);
        if (!raw)
          throw new ActionError(
            "not_found",
            `There's no ${i.link} on the page last read in tab ${i.tabId}. Read the page first.`,
          );
        const url = await assertAllowed(ctx, raw);
        await pace(ctx, url);
        const client = browser(ctx);
        let tab: TabInfo;
        if (i.tabId === undefined || (i.link && i.newTab)) {
          tab = await client.call<TabInfo>("tabs.open", { url });
        } else {
          await findTab(client, i.tabId);
          await client.call("cdp", { tabId: i.tabId, method: "Page.navigate", params: { url } });
          tab = await findTab(client, i.tabId);
        }
        forgetLinks(tab.tabId);
        const loaded = await waitForLoad(client, tab.tabId);
        ctx.emit({ kind: "browser.opened", payload: { tabId: tab.tabId, url } });
        // Only the address asked for: the page's own title and text come from browser_read.
        const notes = await notesForSite(ctx.tx, new URL(url).hostname);
        return {
          tabId: tab.tabId,
          url,
          loaded: !loaded.loading,
          ...(notes.length
            ? { siteNotes: notes.map((n) => ({ id: n.id, title: n.title, body: n.body })) }
            : {}),
        };
      },
    }),
    defineAction({
      name: "browser.read",
      description:
        "Read the page in a tab as text, the way a person sees it. Links show as references like [L4]; follow one with browser_open {tabId, link}. Things you can press or type into show as [button E3: Add to cart], [field E5: Search] and so on: use browser_click, browser_type, browser_choose and browser_submit with them. `sends` lists the ones that would send something (browser_submit, which asks the owner). Long pages come in parts: pass offset to read on.",
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
        const text = page.text.slice(i.offset, i.offset + i.maxChars);
        const refs = new Set([...text.matchAll(/\[L(\d+)\]/g)].map((m) => Number(m[1])));
        const shown = new Set([...text.matchAll(/ (E\d+): /g)].map((m) => m[1]));
        const end = i.offset + text.length;
        const more = page.truncated || end < page.text.length;
        return {
          tabId: i.tabId,
          url: page.url,
          title: page.title,
          text,
          links: [...refs].map((n) => `L${n} ${page.links[n - 1]}`),
          sends: page.elements
            .filter((e) => e.submits && shown.has(e.ref))
            .map((e) => `${e.ref} ${e.label}`),
          next: more && end < MAX_READ ? { offset: end } : null,
        };
      },
    }),
    defineAction({
      name: "browser.screenshot",
      description:
        "Look at a tab: a picture of what it shows now. Use it when the page's look matters (a chart, a layout, a captcha) or reading it as text wasn't enough.",
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
        const shot = await client.call<{ data: string }>("cdp", {
          tabId: i.tabId,
          method: "Page.captureScreenshot",
          params: { format: "jpeg", quality: 60 },
        });
        const modelImages: ModelImage[] = [{ mimeType: "image/jpeg", data: shot.data }];
        return { tabId: i.tabId, url: tab.url, modelImages };
      },
    }),
    defineAction({
      name: "browser.sites",
      description:
        "The owner's site lists: sites Jarvis may open even after reading outside content, and sites it never opens.",
      input: z.object({}),
      risk: "read",
      callers: CALLERS,
      handler: (_i, ctx) => getSetting(ctx.tx, "browser.sites"),
    }),
    defineAction({
      name: "browser.set_sites",
      description: "Change which sites Jarvis may open freely, and which it never opens.",
      input: z.object({
        allowed: z.array(SITE).max(200),
        blocked: z.array(SITE).max(200),
      }),
      risk: "internal",
      // Only you decide where Jarvis may go.
      callers: ["owner"],
      async handler(i, ctx) {
        const tidy = (list: string[]) => [...new Set(list.map((s) => s.trim().toLowerCase()))];
        const sites = { allowed: tidy(i.allowed), blocked: tidy(i.blocked) };
        await setSetting(ctx.tx, "browser.sites", sites);
        ctx.emit({ kind: "browser.sites_changed", payload: { sites } });
        return sites;
      },
    }),
    defineAction({
      name: "browser.set_pace",
      description:
        "Change how long Jarvis waits between steps on a site, so it doesn't look like a bot: a default, and any sites that need longer.",
      input: z.object({
        seconds: z.number().min(0).max(60),
        sites: z.record(SITE, z.number().min(0).max(300)).default({}),
      }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const sites = Object.fromEntries(
          Object.entries(i.sites).map(([s, n]) => [s.trim().toLowerCase(), n]),
        );
        await setSetting(ctx.tx, "browser.pace", { seconds: i.seconds, sites });
        return { seconds: i.seconds, sites };
      },
    }),
    defineAction({
      name: "browser.pace",
      description: "How long Jarvis waits between steps on a site.",
      input: z.object({}),
      risk: "read",
      callers: CALLERS,
      handler: (_i, ctx) => getSetting(ctx.tx, "browser.pace"),
    }),
    defineAction({
      name: "browser.close",
      description:
        "Close one of Jarvis's tabs, or give a tab the owner handed over back to them (it stays open).",
      input: z.object({ tabId: z.number().int() }),
      risk: "internal",
      callers: CALLERS,
      async handler(i, ctx) {
        const client = browser(ctx);
        const tab = await findTab(client, i.tabId);
        await client.call(tab.handed ? "tabs.release" : "tabs.close", { tabId: i.tabId });
        forgetLinks(i.tabId);
        ctx.emit({
          kind: "browser.closed",
          payload: { tabId: i.tabId, handedBack: tab.handed },
        });
        return { closed: !tab.handed, handedBack: tab.handed };
      },
    }),
  ],
});
