// The mouse and keyboard as a person uses them (B1): Chrome's own input events, sent to the tab,
// which routes them into frames from other sites as a real click would. Text is typed key by key;
// a long text, a new line, or a character no key makes goes in as one insert.
import { type Combo, keyEvents, parseCombo } from "@hearth/modules/driver-kit";
import { reasonOf } from "./errors.ts";
import type { Cdp } from "./transport.ts";

export type Button = "left" | "right" | "middle";

/**
 * Sends input that may open a dialog (an alert after a click): the input happened, and the dialog
 * shows in the step's result. Says whether a dialog stopped it.
 */
export async function guarded(send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send();
    return false;
  } catch (err) {
    if (reasonOf(err) === "dialog_open") return true;
    throw err;
  }
}

/** Text longer than this goes in as one insert, not key by key. */
export const KEYSTROKE_LIMIT = 200;

/** "ctrl+shift" as the protocol's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifierBits(mods: string | undefined): number {
  let bits = 0;
  for (const m of (mods ?? "").toLowerCase().split("+")) {
    if (m === "alt" || m === "option") bits |= 1;
    if (m === "ctrl" || m === "control") bits |= 2;
    if (m === "meta" || m === "cmd" || m === "command" || m === "win" || m === "super") bits |= 4;
    if (m === "shift") bits |= 8;
  }
  return bits;
}

const BUTTONS: Record<Button, number> = { left: 1, right: 2, middle: 4 };

export function move(cdp: Cdp, x: number, y: number, modifiers = 0) {
  return cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
}

/** A click (or double or triple click) at a point, after moving there. */
export async function click(
  cdp: Cdp,
  x: number,
  y: number,
  opts: { button?: Button; clickCount?: number; modifiers?: number } = {},
) {
  const button = opts.button ?? "left";
  const modifiers = opts.modifiers ?? 0;
  await move(cdp, x, y, modifiers);
  for (let n = 1; n <= (opts.clickCount ?? 1); n++) {
    const at = { x, y, button, clickCount: n, modifiers };
    const stop = await guarded(async () => {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        buttons: BUTTONS[button],
        ...at,
      });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...at });
    });
    if (stop) return;
  }
}

/** Presses at one point, moves in steps, and lets go at another. */
export async function drag(cdp: Cdp, from: { x: number; y: number }, to: { x: number; y: number }) {
  await move(cdp, from.x, from.y);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  const steps = 8;
  for (let n = 1; n <= steps; n++) {
    const x = from.x + ((to.x - from.x) * n) / steps;
    const y = from.y + ((to.y - from.y) * n) / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
    });
  }
  await guarded(() =>
    cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }),
  );
}

/** The mouse wheel at a point. */
export function wheel(cdp: Cdp, x: number, y: number, deltaX: number, deltaY: number) {
  return cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

/** The key that types a character, if a US keyboard has one. */
function keyFor(ch: string): Combo | null {
  if (ch === " ") return parseCombo("space");
  if (ch === "+") return parseCombo("+");
  try {
    const c = parseCombo(ch);
    return c.key.text === ch ? c : null;
  } catch {
    return null;
  }
}

/** Presses one combination. Says whether a dialog stopped it. */
export function pressCombo(cdp: Cdp, combo: Combo): Promise<boolean> {
  return guarded(async () => {
    for (const event of keyEvents(combo)) await cdp.send("Input.dispatchKeyEvent", event);
  });
}

/**
 * Types text into whatever has focus. Each character is its key, pressed and let go, so pages
 * that listen to keys see typing; new lines and tabs go in as text, never as Enter or Tab, so
 * typing can't send a message or leave the field.
 */
export async function typeText(cdp: Cdp, text: string): Promise<void> {
  if (text.length > KEYSTROKE_LIMIT) {
    await guarded(() => cdp.send("Input.insertText", { text }));
    return;
  }
  let pending = "";
  const flush = async () => {
    const stop = pending
      ? await guarded(() => cdp.send("Input.insertText", { text: pending }))
      : false;
    pending = "";
    return stop;
  };
  for (const ch of text) {
    const combo = /[\r\n\t]/.test(ch) ? null : keyFor(ch);
    if (!combo) {
      pending += ch;
      continue;
    }
    if ((await flush()) || (await pressCombo(cdp, combo))) return;
  }
  await flush();
}
