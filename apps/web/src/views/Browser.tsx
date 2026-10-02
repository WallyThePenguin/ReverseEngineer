// The browser pane: your own Chrome, shown live inside Hearth (D24). You watch Jarvis's tabs and
// the ones you handed it, and take over with your mouse and keyboard at any time.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Button, Empty, PaneHeader } from "../components/ui.tsx";
import {
  createLiveBrowser,
  type LiveBrowser,
  modifiers,
  openChrome,
  toPage,
} from "../lib/browser.ts";
import { layout } from "../lib/panes.ts";
import { watchPage } from "./PageWatch.tsx";

const BUTTONS = ["left", "middle", "right"] as const;

function Screen(props: { b: LiveBrowser }) {
  let surface!: HTMLDivElement;
  let img: HTMLImageElement | undefined;
  let lastMove = 0;

  const at = (e: MouseEvent) => {
    const f = props.b.frame();
    if (!f || !img) return null;
    return toPage({ x: e.clientX, y: e.clientY }, img.getBoundingClientRect(), f);
  };
  const mouse = (kind: string, e: MouseEvent) => {
    const p = at(e);
    if (!p) return;
    props.b.send({
      type: "mouse",
      kind,
      ...p,
      button: kind === "mouseMoved" && e.buttons === 0 ? "none" : (BUTTONS[e.button] ?? "left"),
      clickCount: kind === "mouseMoved" ? 0 : Math.max(1, e.detail),
      modifiers: modifiers(e),
    });
  };

  onMount(() => {
    // Wheel events must not scroll Hearth itself, so this listener can't be passive.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = at(e);
      if (!p) return;
      const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      props.b.send({ type: "wheel", ...p, deltaX: e.deltaX * scale, deltaY: e.deltaY * scale });
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    onCleanup(() => surface.removeEventListener("wheel", wheel));
  });

  const key = (kind: "keyDown" | "keyUp", e: KeyboardEvent) => {
    // While the page has focus, keys go to it, not to Hearth's shortcuts.
    e.stopPropagation();
    if (e.isComposing || e.key === "Unidentified" || e.key === "Dead") return;
    // Ctrl+V pastes your clipboard through the paste event instead.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    props.b.send({ type: "key", kind, key: e.key, code: e.code, modifiers: modifiers(e) });
  };

  return (
    <div
      ref={surface}
      role="application"
      aria-label="Live view of a Chrome tab. Click to use it; keys go to the page."
      // biome-ignore lint/a11y/noNoninteractiveTabindex: it takes your keys for the page it shows.
      tabIndex={0}
      class="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-sunk outline-none focus:ring-2 focus:ring-jarvis/40"
      on:keydown={(e) => key("keyDown", e)}
      on:keyup={(e) => key("keyUp", e)}
      on:paste={(e) => {
        const text = e.clipboardData?.getData("text/plain");
        if (text) props.b.send({ type: "text", text });
        e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Show
        when={props.b.frame()}
        fallback={<p class="text-sm text-muted">Waiting for a picture from Chrome…</p>}
      >
        {(f) => (
          <img
            ref={img}
            src={`data:image/jpeg;base64,${f().data}`}
            alt={props.b.current()?.title ?? "Chrome tab"}
            draggable={false}
            class="max-h-full max-w-full select-none"
            onMouseDown={(e) => {
              surface.focus();
              mouse("mousePressed", e);
            }}
            onMouseUp={(e) => mouse("mouseReleased", e)}
            onMouseMove={(e) => {
              const now = performance.now();
              if (now - lastMove < 50) return;
              lastMove = now;
              mouse("mouseMoved", e);
            }}
          />
        )}
      </Show>
    </div>
  );
}

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
            Open Chrome on your PC with the Hearth extension installed and paired. It connects by
            itself.
          </p>
        }
      >
        <p>
          {o().opening || asked()
            ? "Opening Chrome on your PC…"
            : "Chrome is closed. Hearth opens it on your PC when Jarvis needs it."}
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
        title="Browser"
        sub={
          !b.online()
            ? "Reconnecting to Hearth…"
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
          <Button small onClick={() => b.send({ type: "back" })} title="Back">
            ←
          </Button>
          <Button small onClick={() => b.send({ type: "forward" })} title="Forward">
            →
          </Button>
          <Button small onClick={() => b.send({ type: "reload" })} title="Reload">
            ⟳
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
          <Button small onClick={() => go(true)} title="Open in a new tab in Jarvis's window">
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
        <Show when={b.error()}>
          <p class="border-b border-line bg-accent-soft px-3 py-1 text-xs text-bad">{b.error()}</p>
        </Show>
        <Show
          when={b.tabId() !== null}
          fallback={
            <Empty>
              Jarvis has no tabs open. Type an address above to open one, or hand Jarvis one of your
              tabs with the Hearth button in Chrome.
            </Empty>
          }
        >
          <Screen b={b} />
        </Show>
      </Show>
    </div>
  );
}
