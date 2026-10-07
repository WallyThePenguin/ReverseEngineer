// Keyboard first: single keys (j, k, e), chords (mod+k) and sequences (g then i). Bindings
// registered later win, so a pane's keys override the app's while that pane has focus.

import { onCleanup } from "solid-js";

export interface Binding {
  /** "j", "shift+enter", "mod+k" (Ctrl on Windows, Cmd on Mac), "g i" for a sequence. */
  keys: string;
  run: (e: KeyboardEvent) => void;
  label?: string;
  /** Only active when this returns true (for example, when its pane has focus). */
  when?: () => boolean;
  /** Fire even while typing in a text box. Chords with mod only. */
  inInputs?: boolean;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** What "mod" is called on this computer, for hints: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD = IS_MAC ? "⌘" : "Ctrl";
const stack: Binding[][] = [];
let pending: string | null = null;
let pendingTimer: number | undefined;
let paused = false;

/**
 * No key does anything while the screen it would act on is covered (Hearth can't be reached):
 * inert stops clicks and focus there, not keys heard by the window.
 */
export function pauseHotkeys(on: boolean): void {
  paused = on;
  pending = null;
}

export function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  const key = e.key.toLowerCase();
  if (e.shiftKey && (key.length > 1 || /^[a-z]$/.test(key))) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function handle(e: KeyboardEvent) {
  if (paused || e.isComposing || ["shift", "control", "meta", "alt"].includes(e.key.toLowerCase()))
    return;
  const chord = chordOf(e);
  const inInput = typing(e.target);
  const candidates = pending ? [`${pending} ${chord}`, chord] : [chord];
  for (const combo of candidates) {
    for (let i = stack.length - 1; i >= 0; i--) {
      for (const b of stack[i]!) {
        if (b.keys !== combo) continue;
        if (inInput && !b.inInputs) continue;
        if (b.when && !b.when()) continue;
        e.preventDefault();
        pending = null;
        b.run(e);
        return;
      }
    }
  }
  // Start a sequence if some binding begins with this key.
  if (!inInput && stack.some((g) => g.some((b) => b.keys.startsWith(`${chord} `)))) {
    pending = chord;
    window.clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(() => {
      pending = null;
    }, 1200);
    return;
  }
  pending = null;
}

if (typeof window !== "undefined") window.addEventListener("keydown", handle);

/** Registers bindings for the lifetime of the calling component. */
export function useHotkeys(bindings: Binding[]) {
  stack.push(bindings);
  onCleanup(() => {
    const i = stack.indexOf(bindings);
    if (i >= 0) stack.splice(i, 1);
  });
}

/** Every labelled binding, for the shortcuts sheet. */
export function listHotkeys(): { keys: string; label: string }[] {
  const seen = new Set<string>();
  const out: { keys: string; label: string }[] = [];
  for (const group of stack) {
    for (const b of group) {
      if (!b.label || seen.has(b.keys + b.label)) continue;
      seen.add(b.keys + b.label);
      out.push({ keys: b.keys.replace("mod", MOD), label: b.label });
    }
  }
  return out;
}

/** Moves a selection index through a list with j/k (and arrow keys). */
export function listKeys(opts: {
  count: () => number;
  index: () => number;
  setIndex: (i: number) => void;
  when?: () => boolean;
}): Binding[] {
  const move = (d: number) => () => {
    const n = opts.count();
    if (n === 0) return;
    opts.setIndex(Math.max(0, Math.min(n - 1, opts.index() + d)));
    queueMicrotask(() =>
      document.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" }),
    );
  };
  return [
    { keys: "j", run: move(1), when: opts.when, label: "Next" },
    { keys: "k", run: move(-1), when: opts.when, label: "Previous" },
    { keys: "arrowdown", run: move(1), when: opts.when },
    { keys: "arrowup", run: move(-1), when: opts.when },
  ];
}
