// The phone's bottom bar: the places you go most, Jarvis, and the rest of the menu.

import { For, type JSX, Show } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { JarvisStatusMark, jarvis } from "../jarvis/JarvisPane.tsx";
import { phoneTabs, productOf } from "../lib/apps.ts";
import { layout } from "../lib/panes.ts";
import { askToTalk, mic } from "../lib/speech.ts";

/** Each tab is a sub-product's home (lib/apps.ts). */
const TABS = phoneTabs();

/** A tab: its icon over its name. The one you're on is in ink and bold. */
const tab = (active: boolean) =>
  `relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-micro ${active ? "font-semibold text-ink" : "text-muted"}`;

/**
 * A tab's icon. On the tab you're on it sits on a pill of its sub-product's colour and takes
 * that colour, so every tab, Jarvis's too, plainly shows whether it's the one you're on.
 */
function TabIcon(props: { active: boolean; red?: boolean; children: JSX.Element }) {
  const on = () => (props.red ? "bg-bad/15 text-bad" : "bg-hue/15 text-hue");
  return (
    <span
      class={`flex h-8 w-14 items-center justify-center rounded-full ${props.active ? on() : ""}`}
    >
      {props.children}
    </span>
  );
}

export function TabBar(props: { waiting: number; onMenu: () => void }) {
  const current = () => (jarvis.open() ? null : layout.panes()[layout.focused()]?.view);
  return (
    <nav
      class="flex shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]"
      aria-label="Main"
    >
      <For each={TABS}>
        {(t) => (
          <button
            type="button"
            data-product={productOf(t.view)}
            class={tab(current() === t.view)}
            aria-current={current() === t.view ? "page" : undefined}
            onClick={() => {
              jarvis.toggle(false);
              layout.reset({ view: t.view });
            }}
          >
            <TabIcon active={current() === t.view}>
              <Icon name={t.icon} size={24} />
            </TabIcon>
            {t.label}
            {/* On the icon's corner, after the name for a screen reader, as it always was. */}
            <Show when={t.view === "inbox" && props.waiting > 0}>
              <span class="absolute top-0.5 left-1/2 ml-2 min-w-4 rounded-full bg-accent px-1 text-center text-micro text-on-fill tabular-nums">
                {props.waiting}
              </span>
            </Show>
          </button>
        )}
      </For>
      <button
        type="button"
        data-product="jarvis"
        class={tab(jarvis.open())}
        aria-current={jarvis.open() ? "page" : undefined}
        onClick={() => jarvis.toggle(!jarvis.open())}
      >
        {/* A line mark like the other icons; how Jarvis is shows as the dot on its corner. */}
        <TabIcon active={jarvis.open()}>
          <JarvisStatusMark size={24} glyph />
        </TabIcon>
        Jarvis
      </button>
      <button
        type="button"
        class={tab(mic.state() !== "idle")}
        classList={{ "!text-bad": mic.state() === "listening" }}
        aria-label={mic.state() === "listening" ? "Stop and send" : "Talk to Jarvis"}
        disabled={mic.state() === "working"}
        onClick={() => {
          if (mic.state() === "listening") return mic.stop();
          jarvis.toggle(true);
          askToTalk();
        }}
      >
        <TabIcon active={mic.state() !== "idle"} red={mic.state() === "listening"}>
          <Show
            when={mic.state() === "idle"}
            fallback={
              <Show
                when={mic.state() === "listening"}
                fallback={<Icon name="loader-circle" size={24} class="animate-spin" />}
              >
                <Icon name="square" size={24} filled />
              </Show>
            }
          >
            <Icon name="mic" size={24} />
          </Show>
        </TabIcon>
        {mic.state() === "listening" ? "Stop" : mic.state() === "working" ? "…" : "Talk"}
      </button>
      <button type="button" class={tab(false)} onClick={props.onMenu}>
        <TabIcon active={false}>
          <Icon name="menu" size={24} />
        </TabIcon>
        More
      </button>
    </nav>
  );
}
