// The browser's raw input, as a person's mouse and keyboard would make it, sent to a tab over
// the extension's protocol pass-through.
import { ActionError } from "@hearth/kernel";
import { HEARTH_PAGE } from "./classify.ts";
import { type BrowserClient, reasonOf } from "./client.ts";
import { type Combo, keyEvents, parseCombo } from "./keys.ts";
import { evaluate, pageCall, pageFunction } from "./page.ts";

const PROBE = pageFunction("./page-probe.js", "pageProbe");

export const cdp = (client: BrowserClient, tab: number, method: string, params: object) =>
  client.call("cdp", { tabId: tab, method, params });

/**
 * Runs the part of a step that presses something. A dialog that opens as it's pressed (an alert
 * after a click) stops the rest, but the press happened: the step reports the dialog. Says
 * whether a dialog stopped it.
 */
export async function pressing(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err) {
    if (reasonOf(err) !== "dialog_open") throw err;
    return true;
  }
}

/** Which page a reference belongs to, and the mark that says a page is Hearth's own. */
export interface RefPage {
  doc?: number;
  mark?: string;
}

/** A browser_read reference used on another page than the one it was read from. */
export const movedOn = (tab: number) =>
  `Tab ${tab} is on another page than the one Jarvis read, so nothing was done. Read it again (browser_read) for fresh references.`;

/**
 * A left click at a point, as a person's mouse would make it. Just before pressing, the point is
 * checked to still land on the element meant, so a page can't slide something else under it, on
 * the page the reference was read from and not Hearth's own (`page`).
 */
export async function clickAt(
  client: BrowserClient,
  tab: number,
  ref: string,
  x: number,
  y: number,
  page: RefPage = {},
) {
  const at = { x, y, button: "left", clickCount: 1 };
  await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  const hit = await evaluate<{ ok: boolean; hearth?: boolean; moved?: boolean }>(
    client,
    tab,
    pageCall(PROBE, { op: "hit", ref, x, y, ...page }),
  );
  if (hit?.hearth) throw new ActionError("forbidden", HEARTH_PAGE);
  if (hit?.moved) throw new ActionError("conflict", movedOn(tab));
  if (!hit?.ok)
    throw new ActionError(
      "conflict",
      `Something else moved under ${ref} just before the click. Nothing was pressed; read the page again.`,
    );
  return pressing(async () => {
    await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mousePressed", ...at });
    await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
  });
}

/** Presses one combination ("Enter", "ctrl+a"). */
export function pressCombo(client: BrowserClient, tab: number, combo: Combo) {
  return pressing(async () => {
    for (const event of keyEvents(combo)) await cdp(client, tab, "Input.dispatchKeyEvent", event);
  });
}

export function pressKey(client: BrowserClient, tab: number, key: string) {
  return pressCombo(client, tab, parseCombo(key));
}

/** Types text into whatever has focus, as one paste-like input. */
export const insertText = (client: BrowserClient, tab: number, text: string) =>
  cdp(client, tab, "Input.insertText", { text });
