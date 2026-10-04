// Jarvis on every screen: a chat pane on the right (Ctrl+J), with your recent conversations.

import { createRoot, createSignal, For, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { ago, day, time } from "../lib/format.ts";
import { jarvisLiveness } from "../lib/jarvis-health.ts";
import { narrow } from "../lib/narrow.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import type { ConversationRow, SystemStatus } from "../lib/types.ts";
import { Conversation } from "./Conversation.tsx";

/** Whether Jarvis is up and well, checked every minute as well as on every change (D54). */
function useLiveness() {
  const status = useAction<SystemStatus>(
    "system.status",
    () => ({}),
    () => true,
    () => 60_000,
  );
  return { status, liveness: () => jarvisLiveness(status) };
}

/** "12:47 p.m." today, "Fri 9 a.m." before: the end of a sentence either way. */
function when(d: Date): string {
  const at = day(d) === "today" ? time(d) : `${day(d)} ${time(d)}`;
  return at.endsWith(".") ? at : `${at}.`;
}

/** A red dot for Jarvis's button while it isn't running or its turns are failing. */
export function JarvisDot() {
  const { liveness } = useLiveness();
  return (
    <Show when={liveness().unwell}>
      <span
        class="ml-1.5 inline-block size-2 rounded-full bg-bad align-middle"
        title={liveness().downSince ? "Jarvis isn't running" : "Jarvis's turns are failing"}
      />
    </Show>
  );
}

function createJarvisState() {
  // On a phone Jarvis covers the screen, so it starts closed there.
  const [open, setOpen] = createSignal(
    !narrow() && localStorage.getItem("hearth.jarvisOpen") !== "0",
  );
  const [conversationId, setConversationId] = createSignal<string | null>(null);
  return {
    open,
    conversationId,
    setConversationId,
    toggle(next = !open()) {
      setOpen(next);
      // Opening Jarvis on purpose puts you in its text box; loading the page doesn't.
      if (next)
        queueMicrotask(() =>
          document.querySelector<HTMLTextAreaElement>("aside textarea")?.focus(),
        );
      if (narrow()) return;
      try {
        localStorage.setItem("hearth.jarvisOpen", next ? "1" : "0");
      } catch {}
    },
    newChat() {
      setConversationId(null);
      this.toggle(true);
    },
  };
}

export const jarvis = createRoot(createJarvisState);

export function JarvisPane() {
  const conversations = useAction<ConversationRow[]>("conversation.list", () => ({ limit: 20 }));
  const { status, liveness } = useLiveness();
  const [picking, setPicking] = createSignal(false);
  const current = () => (conversations.data ?? []).find((c) => c.id === jarvis.conversationId());

  return (
    <aside
      class={
        narrow()
          ? "flex h-full min-w-0 flex-1 flex-col bg-panel pt-[env(safe-area-inset-top)]"
          : "flex h-full w-[380px] shrink-0 flex-col border-l border-line bg-panel"
      }
    >
      <header class="flex min-h-12 items-center gap-2 border-b border-line px-3">
        <span class="font-semibold text-jarvis">Jarvis</span>
        <Show when={status.data?.jarvisPaused}>
          <Badge tone="warn">Paused</Badge>
        </Show>
        <button
          type="button"
          class="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm text-muted hover:bg-sunk"
          onClick={() => setPicking(!picking())}
          title="Your conversations"
        >
          {current()?.title ?? "New conversation"} ▾
        </button>
        <Button small onClick={() => jarvis.newChat()} title="New conversation">
          New
        </Button>
        <Show when={jarvis.conversationId() && !narrow()}>
          <Button
            small
            title="Open in a pane"
            onClick={() =>
              layout.open({ view: "chat", id: jarvis.conversationId()! }, { beside: true })
            }
          >
            ⤢
          </Button>
        </Show>
      </header>
      <Show
        when={liveness().downSince}
        fallback={
          <Show when={liveness().detail}>
            {(detail) => (
              <p
                class={`border-b border-line px-3 py-1.5 text-xs ${liveness().unwell ? "text-bad" : "text-muted"}`}
              >
                {detail()}
              </p>
            )}
          </Show>
        }
      >
        {(since) => (
          <p class="border-b border-line bg-accent-soft px-3 py-1.5 text-xs text-bad">
            Jarvis hasn't been running since {when(since())} Hearth is trying to restart it;
            anything you send waits until it's back.
          </p>
        )}
      </Show>
      <Show when={picking()}>
        <ul class="max-h-72 overflow-auto border-b border-line py-1">
          <For each={conversations.data ?? []}>
            {(c) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-sunk"
                  onClick={() => {
                    jarvis.setConversationId(c.id);
                    setPicking(false);
                  }}
                >
                  <span class="flex-1 truncate text-sm">{c.title || "Untitled"}</span>
                  <span class="text-xs text-faint">{ago(c.lastTurnAt ?? c.updatedAt)}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="min-h-0 flex-1">
        <Conversation
          compact
          id={jarvis.conversationId()}
          onCreated={(id) => jarvis.setConversationId(id)}
        />
      </div>
    </aside>
  );
}
