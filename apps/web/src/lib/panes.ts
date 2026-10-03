// Split panes: up to three views side by side, each navigable on its own (Macro's window
// manager idea, kept small). The layout lives in the URL, so reload and back/forward work:
// /inbox+task/0190...+note/0191...

import { createRoot, createSignal } from "solid-js";
import { narrow } from "./narrow.ts";
import {
  decodePath,
  encodePath,
  encodeRoute,
  type ListView,
  MAX_PANES,
  type PaneRoute,
  routeFor,
} from "./routes.ts";

export { type ListView, type PaneRoute, routeFor };

function createPanes() {
  const [panes, setPanes] = createSignal<PaneRoute[]>(decodePath(location.pathname));
  const [focused, setFocused] = createSignal(0);

  const commit = (next: PaneRoute[], focus: number, replace = false) => {
    setPanes(next);
    setFocused(Math.max(0, Math.min(focus, next.length - 1)));
    const url = encodePath(next);
    if (url !== location.pathname) {
      if (replace) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
    }
  };

  window.addEventListener("popstate", () => {
    const next = decodePath(location.pathname);
    setPanes(next);
    setFocused((f) => Math.min(f, next.length - 1));
  });

  return {
    panes,
    focused,
    focus: (i: number) => setFocused(Math.max(0, Math.min(i, panes().length - 1))),
    /** Opens a view in the focused pane, or beside it when `beside` is set (shift-click). */
    open(route: PaneRoute, opts: { beside?: boolean; pane?: number } = {}) {
      const list = [...panes()];
      const at = opts.pane ?? focused();
      if (opts.beside) {
        if (list.length >= MAX_PANES) {
          list[list.length - 1] = route;
          return commit(list, list.length - 1);
        }
        list.splice(at + 1, 0, route);
        return commit(list, at + 1);
      }
      if (encodeRoute(list[at]!) === encodeRoute(route)) return;
      list[at] = route;
      commit(list, at);
    },
    /**
     * Shows a record next to the list it was picked from: in the pane to the right if there is
     * one, otherwise in a new pane. Focus stays on the list so you can keep going with j/k.
     */
    show(route: PaneRoute, from: number) {
      const list = [...panes()];
      if (list.length === 1 || from + 1 >= list.length) {
        if (list.length >= MAX_PANES) list[list.length - 1] = route;
        else list.splice(from + 1, 0, route);
      } else {
        list[from + 1] = route;
      }
      // On a phone only one pane shows, so the record is what you see; closing it goes back.
      commit(list, narrow() ? Math.min(from + 1, list.length - 1) : from);
    },
    close(i = focused()) {
      const list = panes().filter((_, j) => j !== i);
      commit(list.length ? list : [{ view: "inbox" }], Math.min(i, list.length - 1));
    },
    /** Starts over with one view (a phone's tab bar). */
    reset(route: PaneRoute) {
      commit([route], 0);
    },
    /** Splits the focused pane: the same view opens beside it. */
    split() {
      const current = panes()[focused()];
      if (current) this.open(current, { beside: true });
    },
  };
}

export const layout = createRoot(createPanes);
