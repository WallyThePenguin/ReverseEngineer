// Split panes: up to three views side by side, each navigable on its own (Macro's window
// manager idea, kept small). The layout lives in the URL, so reload and back/forward work:
// /inbox+task/0190...+note/0191...
//
// Each pane has a key that stays the same while it's open, so closing or opening a pane beside
// it never hands its keys, focus or close button to a different one. A pane's position is worked
// out from its key whenever it's needed.

import { createMemo, createRoot, createSignal } from "solid-js";
import { narrow } from "./narrow.ts";
import {
  decodePath,
  encodePath,
  encodeRoute,
  HOME,
  type ListView,
  MAX_PANES,
  type PaneRoute,
  routeFor,
} from "./routes.ts";

export { type ListView, type PaneRoute, routeFor };

/** One open pane: what it shows, and a key it keeps while it's open. */
export interface Pane {
  readonly key: number;
  readonly route: PaneRoute;
}

let nextKey = 1;
const fresh = (route: PaneRoute): Pane => ({ key: nextKey++, route });

/**
 * The panes for `routes`, reusing the ones already open that show the same thing, so back and
 * forward don't redraw (and lose the place in) panes that didn't change.
 */
export function reconcile(current: readonly Pane[], routes: PaneRoute[]): Pane[] {
  const pool = [...current];
  return routes.map((route) => {
    const at = pool.findIndex((p) => encodeRoute(p.route) === encodeRoute(route));
    return at >= 0 ? pool.splice(at, 1)[0]! : fresh(route);
  });
}

export function createPanes() {
  const [entries, setEntries] = createSignal<Pane[]>(
    decodePath(location.pathname).map((r) => fresh(r)),
  );
  const [focusedKey, setFocusedKey] = createSignal(entries()[0]!.key);
  const panes = createMemo(() => entries().map((p) => p.route));
  const indexOf = (key: number) => entries().findIndex((p) => p.key === key);
  const focused = () => Math.max(0, indexOf(focusedKey()));

  const commit = (next: Pane[], focus: number, replace = false) => {
    setEntries(next);
    setFocusedKey(next[Math.max(0, Math.min(focus, next.length - 1))]!.key);
    const url = encodePath(next.map((p) => p.route));
    if (url !== location.pathname) {
      if (replace) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
    }
  };

  if (typeof window !== "undefined")
    window.addEventListener("popstate", () => {
      const before = focused();
      const next = reconcile(entries(), decodePath(location.pathname));
      setEntries(next);
      if (!next.some((p) => p.key === focusedKey()))
        setFocusedKey(next[Math.min(before, next.length - 1)]!.key);
    });

  return {
    /** What each pane shows, left to right. */
    panes,
    /** The panes themselves, with their keys (for drawing them). */
    entries,
    /** Where the pane with this key is now (-1 once it's closed). */
    indexOf,
    focused,
    focus: (i: number) => {
      const p = entries()[Math.max(0, Math.min(i, entries().length - 1))];
      if (p) setFocusedKey(p.key);
    },
    /** Opens a view in the focused pane, or beside it when `beside` is set (shift-click). */
    open(route: PaneRoute, opts: { beside?: boolean; pane?: number } = {}) {
      const list = [...entries()];
      const at = Math.max(0, Math.min(opts.pane ?? focused(), list.length - 1));
      if (opts.beside) {
        if (list.length >= MAX_PANES) {
          list[list.length - 1] = fresh(route);
          return commit(list, list.length - 1);
        }
        list.splice(at + 1, 0, fresh(route));
        return commit(list, at + 1);
      }
      if (encodeRoute(list[at]!.route) === encodeRoute(route)) {
        setFocusedKey(list[at]!.key);
        return;
      }
      list[at] = fresh(route);
      commit(list, at);
    },
    /**
     * Shows a record next to the list it was picked from: in the pane to the right if there is
     * one, otherwise in a new pane. Focus stays on the list so you can keep going with j/k.
     */
    show(route: PaneRoute, from: number) {
      const list = [...entries()];
      const here = list[from];
      if (list.length === 1 || from + 1 >= list.length) {
        if (list.length >= MAX_PANES) list[list.length - 1] = fresh(route);
        else list.splice(from + 1, 0, fresh(route));
      } else if (encodeRoute(list[from + 1]!.route) !== encodeRoute(route)) {
        list[from + 1] = fresh(route);
      }
      // On a phone only one pane shows, so the record is what you see; closing it goes back.
      const stay = here && list.includes(here) ? list.indexOf(here) : from;
      commit(list, narrow() ? Math.min(from + 1, list.length - 1) : stay);
    },
    close(i = focused()) {
      const closing = entries()[i];
      if (!closing) return;
      const list = entries().filter((p) => p !== closing);
      if (!list.length) return commit([fresh({ view: HOME })], 0);
      // Focus stays where it was, unless it was on the pane that closed.
      const stay = list.findIndex((p) => p.key === focusedKey());
      commit(list, stay >= 0 ? stay : Math.min(i, list.length - 1));
    },
    /** Starts over with one view (a phone's tab bar). */
    reset(route: PaneRoute) {
      commit([fresh(route)], 0);
    },
    /** Splits the focused pane: the same view opens beside it. */
    split() {
      const current = entries()[focused()];
      if (current) this.open(current.route, { beside: true });
    },
  };
}

export const layout = createRoot(createPanes);
