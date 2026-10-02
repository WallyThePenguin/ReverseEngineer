// Turns a key press from the live view into Chrome's input event. Printable keys type their text;
// Enter, Backspace, arrows and the like need Windows key codes; with Ctrl or Cmd held, nothing is
// typed so shortcuts like Ctrl+A work.

const SPECIAL: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: "\r" },
  Backspace: { code: 8 },
  Tab: { code: 9 },
  Escape: { code: 27 },
  " ": { code: 32, text: " " },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
  End: { code: 35 },
  Home: { code: 36 },
  ArrowLeft: { code: 37 },
  ArrowUp: { code: 38 },
  ArrowRight: { code: 39 },
  ArrowDown: { code: 40 },
  Delete: { code: 46 },
};

const CTRL = 2;
const META = 4;

export function keyEvent(m: {
  kind?: string;
  key?: string;
  code?: string;
  modifiers?: number;
}): Record<string, unknown> {
  const key = m.key ?? "";
  const modifiers = m.modifiers ?? 0;
  const down = m.kind !== "keyUp";
  const special = SPECIAL[key];
  const printable = key.length === 1;
  const shortcut = (modifiers & (CTRL | META)) !== 0;
  const vk = special?.code ?? (printable ? key.toUpperCase().charCodeAt(0) : 0);
  const text = down ? (special?.text ?? (printable && !shortcut ? key : undefined)) : undefined;
  return {
    type: down ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
    key,
    code: m.code ?? "",
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
    ...(text ? { text, unmodifiedText: text } : {}),
  };
}
