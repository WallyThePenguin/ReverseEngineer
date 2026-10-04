// The browser's raw input, as a person's mouse and keyboard would make it, sent to a tab over
// the extension's protocol pass-through.
import { ActionError } from "@hearth/kernel";
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

/**
 * A left click at a point, as a person's mouse would make it. Just before pressing, the point is
 * checked to still land on the element meant, so a page can't slide something else under it.
 */
export async function clickAt(
  client: BrowserClient,
  tab: number,
  ref: string,
  x: number,
  y: number,
) {
  const at = { x, y, button: "left", clickCount: 1 };
  await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  const hit = await evaluate<{ ok: boolean }>(
    client,
    tab,
    pageCall(PROBE, { op: "hit", ref, x, y }),
  );
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
