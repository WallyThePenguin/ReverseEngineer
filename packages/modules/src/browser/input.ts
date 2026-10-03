// The browser's raw input, as a person's mouse and keyboard would make it, sent to a tab over
// the extension's protocol pass-through.
import { ActionError } from "@hearth/kernel";
import type { BrowserClient } from "./client.ts";
import { evaluate, pageCall, pageFunction } from "./page.ts";

const PROBE = pageFunction("./page-probe.js", "pageProbe");

export const cdp = (client: BrowserClient, tab: number, method: string, params: object) =>
  client.call("cdp", { tabId: tab, method, params });

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
  await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mousePressed", ...at });
  await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
}

export const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
} as const;
export type KeyName = keyof typeof KEYS;

export async function pressKey(client: BrowserClient, tab: number, key: KeyName) {
  const k: { code: string; keyCode: number; text?: string } = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode };
  await cdp(client, tab, "Input.dispatchKeyEvent", {
    type: k.text ? "keyDown" : "rawKeyDown",
    ...base,
    ...(k.text ? { text: k.text } : {}),
  });
  await cdp(client, tab, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Types text into whatever has focus, as one paste-like input. */
export const insertText = (client: BrowserClient, tab: number, text: string) =>
  cdp(client, tab, "Input.insertText", { text });
