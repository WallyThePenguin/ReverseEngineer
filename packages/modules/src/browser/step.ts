// What every step of Jarvis's hands shares: the inputs that name a tab, an element and a site, the
// pin that holds a step to its page (D30), and what happens after a step: waiting for the page,
// stepping back from a blocked site, and saying which dialog or new tabs it opened.
import { type ActionContext, ActionError } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed } from "./access.ts";
import type { BrowserClient, TabInfo } from "./client.ts";
import { cdp } from "./input.ts";
import { findTab, forgetLinks, listTabs, waitForLoad } from "./page.ts";

export const tabId = z.number().int();

export const ref = z
  .string()
  .regex(/^E\d+$/)
  .describe('Something on the page, by its reference from browser_read, e.g. "E3".');

export const SITE_CHECK = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "A site name, like shop.example.");

/** A step approved for one site never runs on another the tab has moved to since. */
export function assertSite(tab: TabInfo, site: string | undefined): void {
  if (!site) return;
  const host = new URL(tab.url).hostname;
  if (host !== site && !host.endsWith(`.${site}`))
    throw new ActionError(
      "conflict",
      `Tab ${tab.tabId} is on ${host} now, not ${site}. Nothing was done.`,
    );
}

type Services = { service<T>(name: string): T };

/** The tab's address, for D30's check on acting after outside content. */
export async function tabPin(i: { tabId: number }, services: Services) {
  const client = services.service<BrowserClient>("browser");
  const tabs = await listTabs(client);
  const url = tabs.find((t) => t.tabId === i.tabId)?.url;
  return url ? { url } : null;
}

/** The tab a step works in, and the tabs open before it, to tell which ones it opens. */
export async function beforeStep(client: BrowserClient, id: number) {
  const tabs = await listTabs(client);
  return { tab: await findTab(client, id, tabs), known: new Set(tabs.map((t) => t.tabId)) };
}

export interface StepResult {
  url: string;
  pageChanged: boolean;
  /** Tabs the step opened (a pop-up, a link that opens in a new tab). */
  opened?: { tabId: number; url: string }[];
  /** A dialog the step opened, waiting for browser_dialog. Its message is the page's. */
  dialog?: { type: string; message: string };
  next: string;
}

/** Waits for what a step set off, and steps back from a blocked site it led to. */
export async function afterStep(
  ctx: ActionContext,
  client: BrowserClient,
  before: TabInfo,
  known?: Set<number>,
): Promise<StepResult> {
  const after = await waitForLoad(client, before.tabId);
  const moved = after.url !== before.url;
  if (moved) {
    forgetLinks(before.tabId);
    try {
      await assertAllowed(ctx, after.url);
    } catch (err) {
      await cdp(client, before.tabId, "Page.navigate", { url: before.url }).catch(() => {});
      throw err;
    }
  }
  const opened = known
    ? (await listTabs(client))
        .filter((t) => !known.has(t.tabId))
        .map((t) => ({ tabId: t.tabId, url: t.url }))
    : [];
  const notes: string[] = [];
  if (after.dialog)
    notes.push(
      `A ${after.dialog.type} dialog opened; answer it with browser_dialog before anything else in this tab.`,
    );
  for (const t of opened) notes.push(`It opened tab ${t.tabId}; read it with browser_read.`);
  notes.push("Read the page again to see what changed.");
  return {
    url: after.url,
    pageChanged: moved,
    ...(opened.length ? { opened } : {}),
    ...(after.dialog
      ? { dialog: { type: after.dialog.type, message: after.dialog.message.slice(0, 500) } }
      : {}),
    next: notes.join(" "),
  };
}
