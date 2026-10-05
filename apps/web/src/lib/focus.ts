// Dialogs (Cmd+K, the shortcuts sheet, the phone menu) keep the keyboard inside them while
// they're open, and hand focus back to where it was when they close.

import { onCleanup, onMount } from "solid-js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The element Tab moves to from `from` inside `root`, wrapping at either end. */
export function nextFocus(
  root: HTMLElement,
  from: Element | null,
  back: boolean,
): HTMLElement | null {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
  if (!all.length) return null;
  const at = from ? all.indexOf(from as HTMLElement) : -1;
  if (at < 0) return back ? all[all.length - 1]! : all[0]!;
  return all[(at + (back ? -1 : 1) + all.length) % all.length]!;
}

/** For the lifetime of the calling component: Tab stays in `root`, and focus goes back after. */
export function useDialogFocus(root: () => HTMLElement | undefined) {
  const before = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    const el = root();
    if (e.key !== "Tab" || !el) return;
    e.preventDefault();
    nextFocus(el, document.activeElement, e.shiftKey)?.focus();
  };
  onMount(() => {
    document.addEventListener("keydown", onKey, true);
    const el = root();
    if (el && !el.contains(document.activeElement)) nextFocus(el, null, false)?.focus();
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onKey, true);
    // Back where you were, if that's still on the page.
    if (before?.isConnected) before.focus();
  });
}
