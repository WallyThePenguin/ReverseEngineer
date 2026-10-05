// The phone's bottom bar: the places you go most, Jarvis, and the rest of the menu.

import { For, Show } from "solid-js";
import { JarvisDot, jarvis } from "../jarvis/JarvisPane.tsx";
import { phoneTabs } from "../lib/apps.ts";
import { layout } from "../lib/panes.ts";
import { askToTalk, mic } from "../lib/speech.ts";

/** Each tab is a sub-product's home (lib/apps.ts). */
const TABS = phoneTabs();

export function TabBar(props: { waiting: number; onMenu: () => void }) {
  const current = () => (jarvis.open() ? null : layout.panes()[layout.focused()]?.view);
  const tab = (active: boolean) =>
    `flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs ${active ? "font-semibold text-accent" : "text-muted"}`;
  return (
    <nav
      class="flex shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]"
      aria-label="Main"
    >
      <For each={TABS}>
        {(t) => (
          <button
            type="button"
            class={tab(current() === t.view)}
            onClick={() => {
              jarvis.toggle(false);
              layout.reset({ view: t.view });
            }}
          >
            <span class="relative">
              {t.label}
              <Show when={t.view === "inbox" && props.waiting > 0}>
                <span class="absolute -top-1.5 -right-4 rounded-full bg-accent px-1 text-[10px] text-white">
                  {props.waiting}
                </span>
              </Show>
            </span>
          </button>
        )}
      </For>
      <button
        type="button"
        class={`${tab(jarvis.open())} ${jarvis.open() ? "!text-jarvis" : ""}`}
        onClick={() => jarvis.toggle(!jarvis.open())}
      >
        <span>
          Jarvis
          <JarvisDot />
        </span>
      </button>
      <button
        type="button"
        class={tab(mic.state() !== "idle")}
        classList={{ "!text-red-600": mic.state() === "listening" }}
        aria-label={mic.state() === "listening" ? "Stop and send" : "Talk to Jarvis"}
        disabled={mic.state() === "working"}
        onClick={() => {
          if (mic.state() === "listening") return mic.stop();
          jarvis.toggle(true);
          askToTalk();
        }}
      >
        {mic.state() === "listening" ? "● Stop" : mic.state() === "working" ? "…" : "🎙 Talk"}
      </button>
      <button type="button" class={tab(false)} onClick={props.onMenu}>
        More
      </button>
    </nav>
  );
}
