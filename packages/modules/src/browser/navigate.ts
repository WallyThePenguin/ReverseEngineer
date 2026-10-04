// Moving around in a tab (D52): go to an address, back, forward or reload; scroll with the mouse
// wheel; wait a moment, or for a page to load.
import { ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import type { BrowserClient, TabInfo } from "./client.ts";
import { cdp } from "./input.ts";
import { viewport } from "./look.ts";
import { pace } from "./pace.ts";
import { findTab, forgetLinks, waitForLoad } from "./page.ts";
import { tabId } from "./step.ts";

const MOVES = new Set(["back", "forward", "reload"]);
const moveOf = (url: string) => {
  const m = url.trim().toLowerCase();
  return MOVES.has(m) ? (m as "back" | "forward" | "reload") : null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type History = { currentIndex: number; entries: { id: number; url: string; title: string }[] };

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
    name: "browser.scroll",
    description:
      "Scroll a tab with the mouse wheel: up, down, left or right, by amount wheel steps (about 100 pixels each). Give coordinate, a point [x, y] in the tab's last screenshot, to scroll a part of the page (a list, a map); otherwise it scrolls the middle of the page.",
    input: z.object({
      tabId,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(30).default(3),
      coordinate: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
    }),
    risk: "read",
    callers: CALLERS,
    async handler(i, ctx) {
      const client = browser(ctx);
      const tab = await findTab(client, i.tabId);
      await assertAllowed(ctx, tab.url);
      const before = await viewport(client, i.tabId);
      const scale = before?.scale ?? 1;
      const [x, y] = i.coordinate
        ? [i.coordinate[0] / scale, i.coordinate[1] / scale]
        : [(before?.css.clientWidth ?? 800) / 2, (before?.css.clientHeight ?? 600) / 2];
      const step = i.amount * 100;
      const deltaX = i.direction === "left" ? -step : i.direction === "right" ? step : 0;
      const deltaY = i.direction === "up" ? -step : i.direction === "down" ? step : 0;
      await cdp(client, i.tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
      });
      // Smooth scrolling takes a moment to land.
      await sleep(350);
      const after = await viewport(client, i.tabId);
      const at = (v: typeof after) =>
        v ? { x: Math.round(v.css.pageX), y: Math.round(v.css.pageY) } : null;
      const from = at(before);
      const to = at(after);
      return {
        tabId: i.tabId,
        scrolled: i.direction,
        position: to,
        moved: from && to ? from.x !== to.x || from.y !== to.y : null,
        ...(after?.content
          ? {
              pageSize: {
                width: Math.round(after.content.width),
                height: Math.round(after.content.height),
              },
            }
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
