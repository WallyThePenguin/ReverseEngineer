// The Windows app's two small windows (D53): quick capture (Ctrl+Alt+N) turns a line into a task,
// and Ask Jarvis (Ctrl+Alt+K) is a conversation without the rest of Hearth around it. Esc tucks
// either one away. They share the main window's sign-in.

import { QueryClientProvider } from "@tanstack/solid-query";
import {
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Button } from "../components/ui.tsx";
import { Conversation } from "../jarvis/Conversation.tsx";
import { getMe, setSignedOutHandler } from "../lib/api.ts";
import {
  captureToTask,
  closeMiniWindow,
  type MiniPage,
  pageLink,
  whenShownAgain,
} from "../lib/desktop.ts";
import { live, queryClient, toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act } from "../lib/query.ts";

/**
 * A record Jarvis mentions opens in Hearth's main window (or, in a browser, this tab): a small
 * window has no panes to show it in. Opening one changes the address (lib/panes.ts), so that's
 * where it's caught. The panes are then put back, so a second click on the same mention works.
 */
function sendPagesToMain() {
  const home = layout.panes()[0];
  const push = history.pushState.bind(history);
  let restoring = false;
  history.pushState = (state, unused, url) => {
    // Putting the panes back: this window's own address never changed.
    if (restoring) return;
    const link = url == null ? null : pageLink(String(url), location);
    if (!link) return push(state, unused, url);
    location.href = link;
    restoring = true;
    try {
      if (home) layout.reset(home);
    } finally {
      restoring = false;
    }
  };
  return () => {
    history.pushState = push;
  };
}

function Capture() {
  const [text, setText] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  let box!: HTMLTextAreaElement;

  const save = async () => {
    const task = captureToTask(text());
    if (!task || saving()) return;
    setSaving(true);
    const made = await act("task.create", task);
    setSaving(false);
    if (!made) return;
    setText("");
    toast.show("Added to your tasks.");
    window.setTimeout(closeMiniWindow, 700);
  };

  onMount(() => box.focus());
  return (
    <div class="flex h-full flex-col gap-2 p-3">
      <textarea
        ref={box}
        class="min-h-0 flex-1 resize-none rounded-md border border-line bg-panel px-3 py-2 text-base outline-none focus:border-accent"
        placeholder="What do you need to remember?"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div class="flex items-center gap-2 text-xs text-muted">
        <span class="flex-1">
          Enter adds it to your tasks · Shift+Enter for a new line · Esc closes
        </span>
        <Button
          small
          kind="primary"
          disabled={!text().trim() || saving()}
          onClick={() => void save()}
        >
          Add task
        </Button>
      </div>
    </div>
  );
}

function Ask() {
  const [id, setId] = createSignal<string | null>(null);
  onMount(() => live.start());
  onCleanup(() => live.stop());
  onCleanup(sendPagesToMain());
  return (
    <div class="flex h-full flex-col bg-panel">
      <div class="flex items-center gap-2 border-b border-line px-3 py-2">
        <p class="flex-1 text-sm font-medium text-jarvis">Ask Jarvis</p>
        <Show when={id()}>
          <Button small onClick={() => setId(null)}>
            New chat
          </Button>
        </Show>
        <Button small title="Esc" onClick={closeMiniWindow}>
          Close
        </Button>
      </div>
      <div class="min-h-0 flex-1">
        <Conversation id={id()} onCreated={setId} />
      </div>
    </div>
  );
}

export function MiniApp(props: { page: MiniPage }) {
  const [me, { refetch }] = createResource(getMe);
  setSignedOutHandler(() => {
    live.stop();
    queryClient.clear();
    void refetch();
  });
  // Kept between uses: shown again after you've signed in (or Hearth is back), it looks again.
  const stale = () => me.state === "errored" || (me.state === "ready" && !me()!.signedIn);
  onMount(() => onCleanup(whenShownAgain(stale, () => void refetch())));

  const onKey = (e: KeyboardEvent) => {
    // Esc closes the window, unless something on the page (a menu, say) used it first.
    if (e.key === "Escape" && !e.defaultPrevented) closeMiniWindow();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <QueryClientProvider client={queryClient}>
      <Switch fallback={<p class="p-4 text-muted">Loading…</p>}>
        <Match when={me.error}>
          <p class="p-4 text-muted">Can't reach Hearth's server.</p>
        </Match>
        <Match when={me() && !me()!.signedIn}>
          <p class="p-4 text-muted">
            Sign in to Hearth first: press Ctrl+Alt+H to open it, then come back.
          </p>
        </Match>
        <Match when={me()?.signedIn}>
          <Show when={props.page === "capture"} fallback={<Ask />}>
            <Capture />
          </Show>
        </Match>
      </Switch>
      <div class="pointer-events-none fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        <For each={toast.toasts()}>
          {(t) => (
            <div
              class={`rounded-lg px-4 py-2 text-sm shadow-lg ${t.tone === "error" ? "bg-bad text-on-fill" : "bg-ink text-bg"}`}
            >
              {t.text}
            </div>
          )}
        </For>
      </div>
    </QueryClientProvider>
  );
}
