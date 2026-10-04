// Jarvis's browser (D24, D25, D52): open pages in your own Chrome, read them, look at them, and
// close them again; click, type, press keys, answer dialogs, submit with your yes, and sign in
// from the vault. Reading, looking and most steps go through the server's driver (B1, drive.ts,
// drive-act.ts), one request per step; the older reader and its references remain (look.ts,
// act.ts). It works in Jarvis's own window, in tabs you hand it, and in the pop-ups those open.
// Pages are outside content, so reading one makes the rest of a turn untrusted. Sites on your
// blocked list are off limits to everyone but you; sites you trust let Jarvis act without asking,
// above the floor (D52).
import { ActionError, defineAction, defineModule, getSetting, setSetting } from "@hearth/kernel";
import { z } from "zod";
import { notesForSite } from "../memory/recall.ts";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import { actActions } from "./act.ts";
import type { TabInfo } from "./client.ts";
import { driveLookActions } from "./drive.ts";
import { driveActActions } from "./drive-act.ts";
import { lookActions } from "./look.ts";
import { navigateActions } from "./navigate.ts";
import { pace } from "./pace.ts";
import { findTab, forgetLinks, linkUrl, waitForLoad } from "./page.ts";
import { signInAction } from "./sign-in.ts";
import { stepActions } from "./steps.ts";
import { vaultActions } from "./vault.ts";
import { describeWatch, watchActions, watchFollowUp } from "./watches.ts";

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
  newTab: z.boolean().default(false).describe("Open it in a new tab instead of tabId."),
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
      description:
        "You changed the sites you trust Jarvis to act on, or that it never opens. Payload: sites.",
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
    ...lookActions,
    ...driveLookActions,
    ...driveActActions,
    ...navigateActions,
    ...stepActions,
    ...vaultActions,
    signInAction,
    defineAction({
      name: "browser.tabs",
      description:
        "List the Chrome tabs Jarvis may use (its own window, tabs the owner handed it, and pop-ups those opened), whether Chrome is connected, and any dialog waiting for an answer.",
      input: z.object({}),
      risk: "read",
      callers: CALLERS,
      io: true,
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
            active: t.active,
            ...(t.openerTabId ? { openedFrom: t.openerTabId } : {}),
            ...(t.dialog ? { dialog: { type: t.dialog.type, message: t.dialog.message } } : {}),
            ...(t.error ? { error: t.error } : {}),
          })),
        };
      },
    }),
    defineAction({
      name: "browser.open",
      description:
        "Open a web page in the owner's Chrome, signed in as them: an address, or a link from a page you read (by its reference, with tabId). Returns the tab, and what you remember about the site (siteNotes); read the page with browser_read_page (to act on it) or browser_get_text (to read it).",
      input: OpenInput,
      risk: "read",
      callers: CALLERS,
      io: true,
      opensUrl: target,
      // A link reference is good only in the process that read the page, so it's turned into its
      // address before the call runs or waits for a yes.
      async snapshot(i) {
        if (!i.link) return {};
        const url = target(i);
        if (!url)
          throw new ActionError(
            "not_found",
            `There's no ${i.link} on the page last read in tab ${i.tabId}. Read the page first.`,
          );
        return { url, link: undefined };
      },
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
        let errorText: string | null = null;
        if (i.tabId === undefined || i.newTab) {
          tab = await client.call<TabInfo>("tabs.open", { url });
        } else {
          await findTab(client, i.tabId);
          const res = await client.call<{ errorText?: string } | null>("cdp", {
            tabId: i.tabId,
            method: "Page.navigate",
            params: { url },
          });
          errorText = res?.errorText || null;
          tab = await findTab(client, i.tabId);
        }
        forgetLinks(tab.tabId);
        const loaded = await waitForLoad(client, tab.tabId);
        ctx.emit({ kind: "browser.opened", payload: { tabId: tab.tabId, url } });
        // Only the address asked for: the page's own title and text come from reading it.
        const notes = await notesForSite(ctx.tx, new URL(url).hostname);
        // Why it didn't load, from Chrome (net::ERR_NAME_NOT_RESOLVED), not from the page.
        const failed = errorText ?? loaded.error ?? null;
        return {
          tabId: tab.tabId,
          url,
          loaded: !loaded.loading,
          ...(failed ? { errorText: failed } : {}),
          ...(notes.length
            ? { siteNotes: notes.map((n) => ({ id: n.id, title: n.title, body: n.body })) }
            : {}),
        };
      },
    }),
    defineAction({
      name: "browser.sites",
      description:
        "The owner's site lists: trusted sites (allowed), where Jarvis may open, click, type and send without asking, even after reading outside content, except for payments, passwords and security settings, moving money and deleting an account; and sites it never opens (blocked).",
      input: z.object({}),
      risk: "read",
      callers: CALLERS,
      handler: (_i, ctx) => getSetting(ctx.tx, "browser.sites"),
    }),
    defineAction({
      name: "browser.set_sites",
      description:
        "Change which sites the owner trusts Jarvis to act on without asking (allowed), and which it never opens (blocked).",
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
      io: true,
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
