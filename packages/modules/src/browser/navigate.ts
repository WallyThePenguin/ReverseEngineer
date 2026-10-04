// Moving around in a tab (D52): go to an address, back, forward or reload; wait a moment, or for a
// page to load. Scrolling is the driver's (drive-act.ts).
import { ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import type { BrowserClient, TabInfo } from "./client.ts";
import { cdp } from "./input.ts";
import { pace } from "./pace.ts";
import { findTab, forgetLinks, waitForLoad } from "./page.ts";
import { tabId } from "./step.ts";

const MOVES = new Set(["back", "forward", "reload"]);
const moveOf = (url: string) => {
  const m = url.trim().toLowerCase();
  return MOVES.has(m) ? (m as "back" | "forward" | "reload") : null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type History = {
  currentIndex: number;
  entries: { id: number; url: string; title: string; transitionType?: string }[];
};

/**
 * How a page a form sent shows in the tab's history: "form_submit", and "reload" once it has been
 * reloaded. Reloading one would send the form again (a second order, a second payment) without
 * the "Confirm form resubmission" question Chrome asks you, so its address is loaded afresh.
 */
const FROM_A_FORM = new Set(["form_submit", "reload"]);

/** Sends the tab where it was asked, and says why Chrome couldn't load it, if it couldn't. */
async function go(
  client: BrowserClient,
  tab: TabInfo,
  move: "back" | "forward" | "reload" | null,
  url: string,
  checked: (url: string) => Promise<string>,
): Promise<string | null> {
  const send = <T>(method: string, params: object = {}) =>
    cdp(client, tab.tabId, method, params) as Promise<T>;
  if (move === "reload") {
    const history = await send<History>("Page.getNavigationHistory");
    const now = history.entries[history.currentIndex];
    if (now && FROM_A_FORM.has(now.transitionType ?? "")) {
      const res = await send<{ errorText?: string }>("Page.navigate", { url: now.url });
      return res?.errorText || null;
    }
    await send("Page.reload");
    return null;
  }
  if (move) {
    const history = await send<History>("Page.getNavigationHistory");
    const entry = history.entries[history.currentIndex + (move === "back" ? -1 : 1)];
    if (!entry)
      throw new ActionError("not_found", `There's no page to go ${move} to in tab ${tab.tabId}.`);
    await checked(entry.url);
    await send("Page.navigateToHistoryEntry", { entryId: entry.id });
    return null;
  }
  const res = await send<{ errorText?: string }>("Page.navigate", { url });
  return res?.errorText || null;
}

export const navigateActions = [
  defineAction({
    name: "browser.navigate",
    description:
      'Go somewhere in a tab: an address, or "back", "forward" or "reload". Returns where the tab ended up (finalUrl), its title, and errorText when the page didn\'t load.',
    input: z.object({
      tabId,
      url: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .describe('An address, or "back", "forward", "reload".'),
    }),
    risk: "read",
    callers: CALLERS,
    // It reports the page's own address and title.
    external: true,
    opensUrl: (i) => (moveOf(i.url) ? null : i.url),
    summarize: (i) => {
      const move = moveOf(i.url);
      return move ? `Go ${move} in tab ${i.tabId}` : `Open ${i.url} in tab ${i.tabId}`;
    },
    async handler(i, ctx) {
      const client = browser(ctx);
      const tab = await findTab(client, i.tabId);
      const move = moveOf(i.url);
      const url = await assertAllowed(ctx, move ? tab.url : i.url);
      await pace(ctx, url);
      const checked = (to: string) => assertAllowed(ctx, to);
      const errorText = await go(client, tab, move, url, checked);
      forgetLinks(i.tabId);
      const after = await waitForLoad(client, i.tabId);
      if (after.url !== tab.url) {
        try {
          // A redirect may have led somewhere off limits: step back from it.
          await assertAllowed(ctx, after.url);
        } catch (err) {
          await cdp(client, i.tabId, "Page.navigate", { url: tab.url }).catch(() => {});
          throw err;
        }
      }
      ctx.emit({ kind: "browser.opened", payload: { tabId: i.tabId, url: after.url } });
      return {
        tabId: i.tabId,
        finalUrl: after.url,
        title: after.title,
        loaded: !after.loading,
        errorText: errorText ?? after.error ?? null,
        ...(after.dialog
          ? { dialog: { type: after.dialog.type, message: after.dialog.message } }
          : {}),
      };
    },
  }),
  defineAction({
    name: "browser.wait",
    description:
      "Wait a few seconds (10 at most) for a page to settle, and with tabId, for that tab to finish loading.",
    input: z.object({
      seconds: z.number().min(0).max(10).default(1),
      tabId: tabId.optional(),
    }),
    risk: "read",
    callers: CALLERS,
    async handler(i, ctx) {
      const started = Date.now();
      await sleep(i.seconds * 1000);
      if (i.tabId === undefined) return { waited: i.seconds };
      const client = browser(ctx);
      await findTab(client, i.tabId);
      const left = Math.max(1000, 10_000 - (Date.now() - started));
      const tab = await waitForLoad(client, i.tabId, left);
      return {
        waited: Math.round((Date.now() - started) / 100) / 10,
        tabId: i.tabId,
        loaded: !tab.loading,
        ...(tab.dialog ? { dialogOpen: tab.dialog.type } : {}),
      };
    },
  }),
];
