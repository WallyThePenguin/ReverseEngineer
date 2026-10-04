// A "more" button that opens a short list of actions: on a record's header, on a list row (where
// a phone has no hover and no keyboard), anywhere a row of buttons would crowd.

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";

export interface MenuItem {
  label: string;
  run: () => void;
  /** Shown in red: it removes something (it can still be undone). */
  danger?: boolean;
}

/**
 * A list row's ⋯ button: always there on a phone, which has no pointer to hover with; on a
 * computer it shows on the row you point at or have selected. The row needs the `group` class.
 */
export const ROW_MENU =
  "flex min-h-11 min-w-11 items-center justify-center rounded text-lg leading-none text-muted hover:bg-sunk hover:text-ink md:-my-1 md:min-h-7 md:min-w-7 md:opacity-0 md:group-hover:opacity-100 md:group-data-[active=true]:opacity-100 md:focus:opacity-100 md:aria-expanded:opacity-100";

/** Where the menu goes: under the button, or above it when there's no room below. */
function placement(button: HTMLElement, items: number): Record<string, string> {
  const r = button.getBoundingClientRect();
  const right = `${Math.max(8, window.innerWidth - r.right)}px`;
  const tall = items * 44 + 16;
  return r.bottom + tall > window.innerHeight && r.top > tall
    ? { right, bottom: `${window.innerHeight - r.top + 4}px` }
    : { right, top: `${r.bottom + 4}px` };
}

export function Overflow(props: {
  items: MenuItem[];
  /** What the button says to a screen reader. */
  label?: string;
  /** Classes for the button, to fit where it sits. */
  class?: string;
}) {
  const [open, setOpen] = createSignal(false);
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
    const away = () => close(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", away);
    document.addEventListener("scroll", away, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", away);
      document.removeEventListener("scroll", away, true);
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
          "flex min-h-11 min-w-11 items-center justify-center rounded text-lg leading-none text-muted hover:bg-sunk hover:text-ink md:min-h-7 md:min-w-7"
        }
        aria-label={props.label ?? "More actions"}
        title={props.label ?? "More actions"}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => {
          setOpen(!open());
          if (open()) queueMicrotask(() => items()[0]?.focus());
        }}
      >
        ⋯
      </button>
      <Show when={open()}>
        {/* Drawn over everything, so a scrolling list can't cut it off. */}
        <Portal>
          <div
            ref={menu}
            role="menu"
            aria-label={props.label ?? "More actions"}
            class="fixed z-50 min-w-44 rounded-lg border border-line bg-panel py-1 text-sm shadow-xl"
            style={placement(button, props.items.length)}
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
                  class={`block min-h-11 w-full px-3 text-left hover:bg-sunk focus:bg-sunk focus:outline-none md:min-h-8 ${item.danger ? "text-bad" : ""}`}
                  onClick={() => {
                    close(true);
                    item.run();
                  }}
                >
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
