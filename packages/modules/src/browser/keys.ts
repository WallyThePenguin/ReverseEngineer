// Keys as a person presses them: "Enter", "ctrl+a", "shift+Tab", "a". Each combination becomes
// the protocol's key events (modifiers down, the key, then all up again), with US keyboard codes.
import { ActionError } from "@hearth/kernel";

export interface Key {
  /** The DOM key value: "Enter", "a", "A". */
  key: string;
  code: string;
  keyCode: number;
  /** What it types, for keys that type. */
  text?: string;
}

export interface Combo {
  /** As written back to Jarvis: "ctrl+a". */
  name: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: Key;
}

const NAMED: Record<string, Key> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
};
const ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  del: "delete",
  ins: "insert",
  spacebar: "space",
  down: "arrowdown",
  up: "arrowup",
  left: "arrowleft",
  right: "arrowright",
  pgdn: "pagedown",
  pgup: "pageup",
};
for (let n = 1; n <= 12; n++) NAMED[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

const MODIFIERS: Record<string, "ctrl" | "shift" | "alt" | "meta"> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  windows: "meta",
  super: "meta",
};

// Punctuation on a US keyboard: the key's code and key code, and what Shift makes of it.
const PUNCTUATION: [string, string, string, number][] = [
  ["-", "_", "Minus", 189],
  ["=", "+", "Equal", 187],
  ["[", "{", "BracketLeft", 219],
  ["]", "}", "BracketRight", 221],
  ["\\", "|", "Backslash", 220],
  [";", ":", "Semicolon", 186],
  ["'", '"', "Quote", 222],
  [",", "<", "Comma", 188],
  [".", ">", "Period", 190],
  ["/", "?", "Slash", 191],
  ["`", "~", "Backquote", 192],
];
const DIGIT_SHIFTS = ")!@#$%^&*(";

/** A single character as a key, and whether it takes Shift. */
function charKey(ch: string): { key: Key; shift: boolean } | null {
  if (/^[a-z]$/i.test(ch)) {
    const upper = ch.toUpperCase();
    const key = { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch };
    return { key, shift: ch !== ch.toLowerCase() };
  }
  if (/^\d$/.test(ch))
    return {
      key: { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), text: ch },
      shift: false,
    };
  const shifted = DIGIT_SHIFTS.indexOf(ch);
  if (shifted !== -1)
    return {
      key: { key: ch, code: `Digit${shifted}`, keyCode: 48 + shifted, text: ch },
      shift: true,
    };
  for (const [plain, upper, code, keyCode] of PUNCTUATION) {
    if (ch === plain) return { key: { key: ch, code, keyCode, text: ch }, shift: false };
    if (ch === upper) return { key: { key: ch, code, keyCode, text: ch }, shift: true };
  }
  return null;
}

/** One combination, like "ctrl+shift+Tab" or "+". */
export function parseCombo(raw: string): Combo {
  const parts =
    raw === "+"
      ? ["+"]
      : raw.endsWith("++")
        ? [...raw.slice(0, -2).split("+"), "+"]
        : raw.split("+");
  const combo = { ctrl: false, shift: false, alt: false, meta: false };
  const last = parts.pop() ?? "";
  for (const part of parts) {
    const mod = MODIFIERS[part.trim().toLowerCase()];
    if (!mod)
      throw new ActionError(
        "invalid_input",
        `"${part}" in "${raw}" isn't a modifier key (ctrl, shift, alt or meta).`,
      );
    combo[mod] = true;
  }
  const lower = last.toLowerCase();
  const named = NAMED[ALIASES[lower] ?? lower];
  let key: Key;
  if (named) key = named;
  else {
    const ch = charKey(last);
    if (!ch) throw new ActionError("invalid_input", `"${last}" isn't a key Nook knows.`);
    key = ch.key;
    if (ch.shift) combo.shift = true;
  }
  // With Shift held, a letter is its capital, as a keyboard would make it.
  if (combo.shift && key.text && /^[a-z]$/.test(key.key))
    key = { ...key, key: key.key.toUpperCase(), text: key.key.toUpperCase() };
  const mods = [
    combo.ctrl && "ctrl",
    combo.alt && "alt",
    combo.meta && "meta",
    combo.shift && "shift",
  ];
  const name = [...mods.filter(Boolean), key.key === " " ? "Space" : key.key].join("+");
  return { name, ...combo, key };
}

/** "ctrl+a Backspace" as its combinations, in order. */
export function parseKeys(keys: string): Combo[] {
  const combos = keys.trim().split(/\s+/).filter(Boolean).map(parseCombo);
  if (combos.length === 0) throw new ActionError("invalid_input", "Say which keys to press.");
  return combos;
}

/** It types a character into the page (no Ctrl, Alt or Meta held). */
export const types = (c: Combo) =>
  Boolean(c.key.text) && c.key.key !== "Enter" && !c.ctrl && !c.alt && !c.meta;

/** Pasting would send whatever is on the owner's clipboard. */
export function isPaste(c: Combo): boolean {
  const lower = c.key.key.toLowerCase();
  return ((c.ctrl || c.meta) && lower === "v") || (c.shift && c.key.key === "Insert");
}

// Editing commands for shortcuts Chrome doesn't run from synthetic key events on every system.
const COMMANDS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  z: "undo",
  y: "redo",
};

/** The modifier bits the protocol wants: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const bits = (m: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }) =>
  (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);

const MOD_KEYS = [
  ["ctrl", "Control", "ControlLeft", 17],
  ["alt", "Alt", "AltLeft", 18],
  ["meta", "Meta", "MetaLeft", 91],
  ["shift", "Shift", "ShiftLeft", 16],
] as const;

/** The protocol's key events for one combination, in the order they're sent. */
export function keyEvents(c: Combo): Record<string, unknown>[] {
  const held = { ctrl: false, alt: false, meta: false, shift: false };
  const out: Record<string, unknown>[] = [];
  const mods = MOD_KEYS.filter(([m]) => c[m]);
  for (const [m, key, code, keyCode] of mods) {
    held[m] = true;
    out.push({
      type: "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers: bits(held),
    });
  }
  const base = {
    key: c.key.key,
    code: c.key.code,
    windowsVirtualKeyCode: c.key.keyCode,
    modifiers: bits(held),
  };
  const command = (c.ctrl || c.meta) && !c.alt ? COMMANDS[c.key.key.toLowerCase()] : undefined;
  const redo = command === "undo" && c.shift ? "redo" : command;
  if (types(c) || c.key.key === "Enter")
    out.push({ type: "keyDown", ...base, text: c.key.text, unmodifiedText: c.key.text });
  else out.push({ type: "rawKeyDown", ...base, ...(redo ? { commands: [redo] } : {}) });
  out.push({ type: "keyUp", ...base });
  for (const [m, key, code, keyCode] of [...mods].reverse()) {
    held[m] = false;
    out.push({ type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: bits(held) });
  }
  return out;
}
