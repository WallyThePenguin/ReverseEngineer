// The phone's bottom bar: Today, Mail, Jarvis in the middle, Tasks, and More for the rest.

import { For, type JSX, Match, Show, Switch } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { JarvisStatusMark, jarvis } from "../jarvis/JarvisPane.tsx";
import { type Place, phoneTabs, productOf } from "../lib/apps.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import { askToTalk, mic } from "../lib/speech.ts";

/** Each tab is a sub-product's home, or Jarvis (lib/apps.ts). */
const TABS = phoneTabs();

/** How long a press on Jarvis's tab lasts before it starts listening. */
const HOLD_MS = 450;

/**
 * A tab: its icon over its name. The one you're on is in ink and bold. Five share the screen's
 * width, down to 320 px, so none is wider than its share (min-w-0).
 */
const tab = (active: boolean) =>
  `relative flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-micro ${active ? "font-semibold text-ink" : "text-muted"}`;

/**
 * A tab's icon. On the tab you're on it sits on a pill of its sub-product's colour and takes
 * that colour, so every tab, Jarvis's too, plainly shows whether it's the one you're on.
 */
function TabIcon(props: { active: boolean; red?: boolean; children: JSX.Element }) {
  const on = () => (props.red ? "bg-bad/15 text-bad" : "bg-hue/15 text-hue");
  return (
    <span
      class={`flex h-8 w-full max-w-14 items-center justify-center rounded-full ${props.active ? on() : ""}`}
    >
      {props.children}
    </span>
  );
}

/** A count on the icon's corner, read after the tab's name by a screen reader. */
function Badge(props: { count: number }) {
  return (
    <Show when={props.count > 0}>
      <span class="absolute top-0.5 left-1/2 ml-2 min-w-4 rounded-full bg-accent px-1 text-center text-micro text-on-fill tabular-nums">
        {props.count}
      </span>
    </Show>
  );
}

/**
 * Jarvis's tab, in the middle. A tap opens or closes its pane, where Talk is. Holding it opens
 * the pane already listening, and while it listens a tap stops and sends.
 */
function JarvisTab() {
  let timer: number | undefined;
  let held = false;
  const listening = () => mic.state() === "listening";
  const press = () => {
    held = false;
    if (mic.state() !== "idle") return;
    timer = window.setTimeout(() => {
      held = true;
      jarvis.toggle(true);
      askToTalk();
    }, HOLD_MS);
  };
  const release = () => window.clearTimeout(timer);
  return (
    <button
      type="button"
      data-product="jarvis"
      // A long press mustn't select the name or open the phone's own menu.
      class={`${tab(jarvis.open() || mic.state() !== "idle")} touch-manipulation select-none [-webkit-touch-callout:none]`}
      aria-current={jarvis.open() ? "page" : undefined}
      aria-label={listening() ? "Stop and send" : undefined}
      title="Jarvis (hold to talk)"
      disabled={mic.state() === "working"}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (held) {
          held = false;
          return;
        }
        if (listening()) return mic.stop();
        jarvis.toggle(!jarvis.open());
      }}
    >
      <TabIcon active={jarvis.open() || mic.state() !== "idle"} red={listening()}>
        <Switch fallback={<JarvisStatusMark size={24} glyph />}>
          <Match when={listening()}>
            <Icon name="square" size={24} filled />
          </Match>
          <Match when={mic.state() === "working"}>
            <Icon name="loader-circle" size={24} class="animate-spin" />
          </Match>
        </Switch>
      </TabIcon>
      {listening() ? "Stop" : "Jarvis"}
    </button>
  );
}

export function TabBar(props: { waiting: number; onMenu: () => void }) {
  const mail = useAction<{ unread: number; toReply: number }>("mail.counts");
  const current = () => (jarvis.open() ? null : layout.panes()[layout.focused()]?.view);
  // Today shows what's waiting for you; Mail, the replies you owe.
  const count = (p: Place) =>
    p.view === "today" ? props.waiting : p.view === "mail" ? (mail.data?.toReply ?? 0) : 0;
  return (
    <nav
      class="flex shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]"
      aria-label="Main"
    >
      <For each={TABS}>
        {(t) =>
          t === "jarvis" ? (
            <JarvisTab />
          ) : (
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
              <Badge count={count(t)} />
            </button>
          )
        }
      </For>
      <button type="button" class={tab(false)} onClick={props.onMenu}>
        <TabIcon active={false}>
          <Icon name="menu" size={24} />
        </TabIcon>
        More
      </button>
    </nav>
  );
}
