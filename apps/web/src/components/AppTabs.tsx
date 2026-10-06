// The tabs along the top of a sub-product with more than one list: Docs' Notes, Sheets and Boards,
// Jarvis's What Jarvis did, Memory and Chrome. They stand where the pane's title would be, and the
// one you're on is its title. Shift-click opens one beside, like the sidebar. Today's Updates says
// how many you haven't seen, as Today's own badge counts only what Today shows.

import { For, Show } from "solid-js";
import { appOf, placeOf } from "../lib/apps.ts";
import { layout } from "../lib/panes.ts";
import type { ListView } from "../lib/routes.ts";
import { useUnseenUpdates } from "../lib/waiting.ts";

/** The lists of the sub-product this one belongs to, when it has more than one. */
export const tabsFor = (view: ListView): readonly ListView[] | null => {
  const views = appOf(view).views;
  return views.length > 1 ? views : null;
};

export function AppTabs(props: { view: ListView; pane: number }) {
  const app = () => appOf(props.view);
  const unseen = useUnseenUpdates();
  const count = (view: ListView) => (view === "inbox" ? unseen() : 0);
  return (
    <nav aria-label={app().label} class="-ml-2 flex min-w-0 flex-wrap items-center">
      <For each={app().views}>
        {(view) => {
          const on = () => view === props.view;
          const place = placeOf(view);
          return (
            <button
              type="button"
              class={`inline-flex min-h-11 items-center rounded-md px-2 py-0.5 text-title whitespace-nowrap md:min-h-0 ${on() ? "text-ink" : "font-medium text-faint hover:bg-sunk hover:text-muted"}`}
              aria-current={on() ? "page" : undefined}
              title={`${place.label} (${place.keys})`}
              onClick={(e) => {
                if (!on() || e.shiftKey)
                  layout.open({ view }, { pane: props.pane, beside: e.shiftKey });
              }}
            >
              {place.label}
              <Show when={count(view)}>
                <span class="ml-1.5 inline-block rounded-full bg-accent px-1.5 align-[3px] text-micro font-semibold text-on-fill tabular-nums">
                  {count(view)}
                  <span class="sr-only"> new</span>
                </span>
              </Show>
            </button>
          );
        }}
      </For>
    </nav>
  );
}
