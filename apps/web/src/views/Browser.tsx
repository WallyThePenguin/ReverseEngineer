// The browser pane: your own Chrome, shown live inside Hearth (D24). You watch Jarvis's tabs and
// the ones you handed it, and take over with your mouse and keyboard at any time.

import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { Button, Empty, PaneHeader } from "../components/ui.tsx";
import { createLiveBrowser, type LiveBrowser, openChrome } from "../lib/browser.ts";
import { layout } from "../lib/panes.ts";
import { DialogBar, Screen } from "./browser/Screen.tsx";
import { watchPage } from "./PageWatch.tsx";

/** Chrome isn't connected: open it from here, or pair it in Settings. */
function ChromeClosed(props: { b: LiveBrowser }) {
  const [asked, setAsked] = createSignal(false);
  const open = async () => {
    setAsked(true);
    try {
      await openChrome();
    } catch {
      // The reason arrives with the live view's state, below.
    } finally {
      setAsked(false);
    }
  };
  const o = () => props.b.opener();
  return (
    <div class="space-y-3 px-4 py-10 text-center text-sm text-muted">
      <Show
        when={o().canOpen && o().paired}
        fallback={
          <p>
            Open Chrome on your PC with the Nook extension installed and paired. It connects by
            itself.
          </p>
        }
      >
        <p>
          {o().opening || asked()
            ? "Opening Chrome on your PC…"
            : "Chrome is closed. Nook opens it on your PC when Pip needs it."}
        </p>
        <Button kind="primary" onClick={() => void open()} disabled={asked()}>
          Open Chrome
        </Button>
        <Show when={o().openError && !o().opening}>
          <p class="mx-auto max-w-md text-bad">{o().openError}</p>
        </Show>
      </Show>
      <p>
        <button
          type="button"
          class="text-jarvis underline"
          onClick={() => layout.open({ view: "settings" })}
        >
          Pair Chrome in Settings
        </button>
      </p>
    </div>
  );
}

export function Browser() {
  const b = createLiveBrowser();
  onCleanup(() => b.stop());
  const [address, setAddress] = createSignal("");
  // The address bar follows the tab unless you're typing in it.
  let editing = false;
  createEffect(
    on(
      () => b.current()?.url,
      (url) => {
        if (!editing) setAddress(url ?? "");
      },
    ),
  );

  const go = (newTab: boolean) => {
    let url = address().trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (newTab || b.tabId() === null) b.send({ type: "open", url });
    else b.send({ type: "navigate", url });
  };

  return (
    <div class="flex h-full flex-col">
      <PaneHeader
        title="Chrome"
        sub={
          !b.online()
            ? "Reconnecting to Nook…"
            : b.connected()
              ? "Your Chrome, live. Click into the page to use it."
              : b.opener().opening
                ? "Opening Chrome…"
                : "Chrome isn't connected."
        }
      >
        <Show when={b.tabs().length > 0}>
          <select
            class="max-w-56 rounded-md border border-line bg-panel px-2 py-1 text-sm"
            value={b.tabId() ?? ""}
            onChange={(e) => b.view(Number(e.currentTarget.value))}
            aria-label="Tab to watch"
          >
            <For each={b.tabs()}>
              {(t) => (
                <option value={t.tabId}>
                  {t.handed ? "Yours: " : ""}
                  {t.title || t.url || "New tab"}
                </option>
              )}
            </For>
          </select>
        </Show>
      </PaneHeader>
      <Show when={b.connected()} fallback={<ChromeClosed b={b} />}>
        <form
          class="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            go(false);
          }}
        >
          <Button small onClick={() => b.send({ type: "back" })} title="Back" label="Back">
            <Icon name="arrow-left" size={14} class="my-0.5" />
          </Button>
          <Button small onClick={() => b.send({ type: "forward" })} title="Forward" label="Forward">
            <Icon name="arrow-right" size={14} class="my-0.5" />
          </Button>
          <Button small onClick={() => b.send({ type: "reload" })} title="Reload" label="Reload">
            <Icon name="rotate-cw" size={14} class="my-0.5" />
          </Button>
          <input
            class="min-w-40 flex-1 rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs"
            value={address()}
            placeholder="Type an address"
            aria-label="Address"
            onFocus={() => (editing = true)}
            onBlur={() => (editing = false)}
            onInput={(e) => setAddress(e.currentTarget.value)}
          />
          <Button small onClick={() => go(true)} title="Open in a new tab in Pip's window">
            New tab
          </Button>
          <Show when={b.current()?.url.startsWith("http")}>
            <Button
              small
              title="Get a notice when this page changes"
              onClick={() => {
                const t = b.current();
                if (t) void watchPage(t.url, t.title);
              }}
            >
              Watch
            </Button>
          </Show>
          <Show when={b.current() && !b.current()?.handed}>
            <Button small kind="danger" onClick={() => b.send({ type: "close" })} title="Close">
              Close
            </Button>
          </Show>
        </form>
        <Show when={b.problem()}>
          <p class="border-b border-line bg-accent-soft px-3 py-1 text-xs text-warn">
            {b.problem()}
          </p>
        </Show>
        <DialogBar b={b} />
        <Show when={b.error() && !b.current()?.dialog}>
          <p class="border-b border-line bg-accent-soft px-3 py-1 text-xs text-bad">{b.error()}</p>
        </Show>
        <Show
          when={b.tabId() !== null}
          fallback={
            <Empty>
              Pip has no tabs open. Type an address above to open one, or hand Pip one of your tabs
              with the Nook button in Chrome.
            </Empty>
          }
        >
          <Screen b={b} />
        </Show>
      </Show>
    </div>
  );
}
