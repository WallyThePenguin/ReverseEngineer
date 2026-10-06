// The live tab in the browser pane: the picture Chrome sends, which takes your mouse, wheel and
// keys for the page, and a bar to answer a dialog the page opened.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../../components/ui.tsx";
import { type LiveBrowser, modifiers, toPage } from "../../lib/browser.ts";

const BUTTONS = ["left", "middle", "right"] as const;

export function Screen(props: { b: LiveBrowser }) {
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

/**
 * The page opened a dialog (an alert, a confirm, a prompt, a "leave site?"). Nothing else works in
 * the tab until it's answered, so you can answer it here.
 */
export function DialogBar(props: { b: LiveBrowser }) {
  const dialog = () => props.b.current()?.dialog ?? null;
  const [text, setText] = createSignal<string | null>(null);
  const answer = (accept: boolean) => {
    const d = dialog();
    props.b.send({
      type: "dialog",
      accept,
      ...(d?.type === "prompt" && accept ? { promptText: text() ?? d.defaultPrompt ?? "" } : {}),
    });
    setText(null);
  };
  return (
    <Show when={dialog()}>
      {(d) => (
        <div class="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-3 py-1.5 text-sm">
          <span class="min-w-0 flex-1 break-words">
            {d().type === "beforeunload" ? "The page asks whether to leave it." : "The page asks:"}{" "}
            <span class="text-muted">{d().type === "beforeunload" ? "" : d().message}</span>
          </span>
          <Show when={d().type === "prompt"}>
            <input
              class="min-w-32 rounded-md border border-line bg-panel px-2 py-0.5 text-xs"
              aria-label="Your answer"
              value={text() ?? d().defaultPrompt ?? ""}
              onInput={(e) => setText(e.currentTarget.value)}
            />
          </Show>
          <Button small kind="primary" onClick={() => answer(true)}>
            {d().type === "beforeunload" ? "Leave" : "OK"}
          </Button>
          <Show when={d().type !== "alert"}>
            <Button small onClick={() => answer(false)}>
              {d().type === "beforeunload" ? "Stay" : "Cancel"}
            </Button>
          </Show>
        </div>
      )}
    </Show>
  );
}
