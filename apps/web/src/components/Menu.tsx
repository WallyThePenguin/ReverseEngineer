// A "more" button that opens a short list of actions: on a record's header, on a list row (where
// a phone has no hover and no keyboard), anywhere a row of buttons would crowd. With its own
// content in place of the "…", it's a named menu, as Hearth's at the top of the sidebar.

import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon, type IconName } from "./icons.tsx";

export interface MenuItem {
  label: string;
  run: () => void;
  icon?: IconName;
  /** Shown in red: it removes something (it can still be undone). */
  danger?: boolean;
}

/**
 * A list row's "more" button: always there on a phone, which has no pointer to hover with; on a
 * computer it shows on the row you point at or have selected. The row needs the `group` class.
 */
export const ROW_MENU =
  "flex min-h-11 min-w-11 items-center justify-center rounded text-muted hover:bg-sunk hover:text-ink md:-my-1 md:min-h-7 md:min-w-7 md:opacity-0 md:group-hover:opacity-100 md:group-data-[active=true]:opacity-100 md:focus:opacity-100 md:aria-expanded:opacity-100";

/**
 * Where the menu goes: under the button, or above it when there's no room below; lined up with
 * the button's right edge, or its left one for a menu that opens from the left of the screen.
 */
function placement(button: HTMLElement, items: number, start: boolean): Record<string, string> {
  const r = button.getBoundingClientRect();
  const side: Record<string, string> = start
    ? { left: `${Math.max(8, r.left)}px` }
    : { right: `${Math.max(8, window.innerWidth - r.right)}px` };
  const tall = items * 44 + 16;
  return r.bottom + tall > window.innerHeight && r.top > tall
    ? { ...side, bottom: `${window.innerHeight - r.top + 4}px` }
    : { ...side, top: `${r.bottom + 4}px` };
}

export function Overflow(props: {
  items: MenuItem[];
  /** What the button says to a screen reader. */
  label?: string;
  /** Classes for the button, to fit where it sits. */
  class?: string;
  /** What the button shows in place of the "…", for a named menu. */
  children?: JSX.Element;
  /** Opens lined up with the button's left edge. */
  start?: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const [where, setWhere] = createSignal<Record<string, string>>({});
  let button!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;

  const items = () => (menu ? [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")] : []);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.focus();
  };
  // Listening only while it's open: a long list has one of these on every row.
  createEffect(() => {
    if (!open()) return;
    const outside = (e: Event) => {
      if (!menu?.contains(e.target as Node) && !button.contains(e.target as Node)) close(false);
    };
    // The list moved under it (you scrolled, or a live update shifted the rows): it follows its
    // button, and closes only once the button is gone or out of sight.
    const follow = () => {
      const r = button.getBoundingClientRect();
      if (!button.isConnected || r.bottom < 0 || r.top > window.innerHeight) close(false);
      else setWhere(placement(button, props.items.length, !!props.start));
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", follow);
    document.addEventListener("scroll", follow, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", follow);
      document.removeEventListener("scroll", follow, true);
    });
  });

  const move = (by: number) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    all[(at + by + all.length) % all.length]?.focus();
  };

  return (
    <div class="shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        ref={button}
        type="button"
        class={
          props.class ??
          "flex min-h-11 min-w-11 items-center justify-center rounded text-muted hover:bg-sunk hover:text-ink md:min-h-7 md:min-w-7"
        }
        aria-label={props.label ?? "More actions"}
        title={props.label ?? "More actions"}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => {
          setWhere(placement(button, props.items.length, !!props.start));
          setOpen(!open());
          if (open()) queueMicrotask(() => items()[0]?.focus({ preventScroll: true }));
        }}
      >
        {props.children ?? <Icon name="ellipsis" size={18} />}
      </button>
      <Show when={open()}>
        {/* Drawn over everything, so a scrolling list can't cut it off. */}
        <Portal>
          <div
            ref={menu}
            role="menu"
            aria-label={props.label ?? "More actions"}
            class="fixed z-50 min-w-44 rounded-lg border border-line bg-panel py-1 text-sm shadow-xl"
            style={where()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Keys pressed in the menu are the menu's, not the list's behind it (j, arrows, x).
              if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                close(true);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              } else if (e.key === "Tab") close(false);
            }}
          >
            <For each={props.items}>
              {(item) => (
                <button
                  type="button"
                  role="menuitem"
                  class={`flex min-h-11 w-full items-center gap-2.5 px-3 text-left hover:bg-sunk focus:bg-sunk focus:outline-none md:min-h-8 ${item.danger ? "text-bad" : ""}`}
                  onClick={() => {
                    close(true);
                    item.run();
                  }}
                >
                  <Show when={item.icon}>
                    {(icon) => <Icon name={icon()} class={item.danger ? "" : "text-faint"} />}
                  </Show>
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
