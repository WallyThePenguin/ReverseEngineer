// What every step of Jarvis's hands shares: the inputs that name a tab, an element and a site, the
// pin that holds a step to its page (D30), and what happens after a step: waiting for the page,
// stepping back from a blocked site, and saying which dialog or new tabs it opened.
import { type ActionContext, ActionError } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed } from "./access.ts";
import { HEARTH_MARK, HEARTH_PAGE, isHearthPage } from "./classify.ts";
import { type BrowserClient, reasonOf, type TabInfo } from "./client.ts";
import { cdp } from "./input.ts";
import { evaluate, findTab, forgetLinks, listTabs, waitForLoad } from "./page.ts";

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

/** A tab's page as it says itself: where it is, which page it is, and whether it's Hearth's. */
export interface Here {
  href: string;
  /** When the page began: a new page differs, a #part or a history step within it doesn't. */
  doc: number;
  hearth: boolean;
}

// A page whose head is still coming in can't say yet whether it's Hearth's.
const HERE = `(document.readyState === "loading" && !document.body ? null : { href: location.href, doc: performance.timeOrigin, mark: document.querySelector(${JSON.stringify(HEARTH_MARK)}) !== null })`;

// What each tab's page last said it was. A page waiting on a dialog can't be asked, so OK there
// goes by this: Hearth's own known only by its mark (its dev server, a proxy) stays the owner's.
const looks = new Map<number, { origin: string; hearth: boolean }>();
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/** The tab's page, at the address it's at now, was Hearth's own when Jarvis last looked. */
export function lookedHearth(tab: TabInfo): boolean {
  const last = looks.get(tab.tabId);
  return Boolean(last?.hearth && last.origin === originOf(tab.url));
}

/** How long a page may take to say where it is: one that doesn't can't be told from Hearth's. */
export const HERE_MS = 5_000;

/**
 * Asks a tab's page where it is, and whether it's Hearth's own: by its address, or by the mark in
 * its head whatever address reached it (a proxy, Hearth's dev server). Null if it doesn't answer.
 */
export async function hereOf(client: BrowserClient, tabId: number): Promise<Here | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, HERE_MS, null);
  });
  const asked = evaluate<{ href: string; doc: number; mark: boolean }>(client, tabId, HERE).catch(
    (err) => {
      // A dialog in the way, a tab that isn't Jarvis's, Chrome away: those say so themselves.
      if (reasonOf(err) || (err instanceof ActionError && err.code === "unavailable")) throw err;
      return null;
    },
  );
  const said = await Promise.race([asked, late]).finally(() => clearTimeout(timer));
  if (typeof said?.href !== "string") return null;
  const here = { href: said.href, doc: said.doc, hearth: said.mark || isHearthPage(said.href) };
  looks.delete(tabId);
  looks.set(tabId, { origin: originOf(here.href), hearth: here.hearth });
  if (looks.size > 50) looks.delete(looks.keys().next().value!);
  return here;
}

const unknown = (tabId: number) =>
  `Jarvis couldn't tell what page tab ${tabId} is on, so it didn't go ahead. Try again once the page has loaded.`;

/**
 * For anyone but the owner, as a step that presses, types or uses keys begins and again before
 * each press: refuses Hearth's own page, a page that doesn't say where it is, and (given where the
 * step began) another page than that one, so a page that goes to Hearth's while Jarvis waits or
 * presses stops the step there. Returns where the step began; `pressed` says what already was.
 */
export async function assertHere(
  ctx: ActionContext,
  client: BrowserClient,
  tabId: number,
  began: Here | null = null,
  pressed = "",
): Promise<Here | null> {
  if (ctx.caller.kind === "owner") return null;
  const now = await hereOf(client, tabId);
  const tail = pressed ? ` (Already pressed: ${pressed}.)` : "";
  if (!now) throw new ActionError("conflict", `${unknown(tabId)}${tail}`);
  if (now.hearth) throw new ActionError("forbidden", `${HEARTH_PAGE}${tail}`);
  if (began && now.doc !== began.doc)
    throw new ActionError(
      "conflict",
      `The tab went to another page partway through, so Jarvis stopped there.${tail}`,
    );
  return now;
}

/** tabPin, for a step that presses, types or uses keys: on Hearth's own page it's refused before
 * a card asks you, since it would be refused after your yes anyway. It never fails: a pin that
 * did would be taken for none, and skip D30's ask. */
export async function handsPin(
  i: { tabId: number },
  services: Services,
): Promise<{ url: string; refused?: string } | null> {
  const client = services.service<BrowserClient>("browser");
  const tab = (await listTabs(client).catch(() => [])).find((t) => t.tabId === i.tabId);
  if (!tab?.url) return null;
  const pinned = { url: tab.url };
  if (isHearthPage(tab.url)) return { ...pinned, refused: HEARTH_PAGE };
  // A page waiting on a dialog can't be asked anything until it's answered.
  if (tab.dialog) return lookedHearth(tab) ? { ...pinned, refused: HEARTH_PAGE } : pinned;
  // A dialog that opened just now: the step itself looks again.
  const here = await hereOf(client, i.tabId).catch(() => undefined);
  if (here === undefined) return pinned;
  if (!here) return { ...pinned, refused: unknown(i.tabId) };
  return here.hearth ? { ...pinned, refused: HEARTH_PAGE } : pinned;
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
  for (const t of opened) notes.push(`It opened tab ${t.tabId}; read it with browser_read_page.`);
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
