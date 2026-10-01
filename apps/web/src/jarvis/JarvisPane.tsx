// Jarvis on every screen: a chat pane on the right (Ctrl+J), with your recent conversations.

import { createRoot, createSignal, For, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import type { ConversationRow, SystemStatus } from "../lib/types.ts";
import { Conversation } from "./Conversation.tsx";

function createJarvisState() {
  const [open, setOpen] = createSignal(localStorage.getItem("hearth.jarvisOpen") !== "0");
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
  const status = useAction<SystemStatus>("system.status");
  const [picking, setPicking] = createSignal(false);
  const current = () => (conversations.data ?? []).find((c) => c.id === jarvis.conversationId());

  return (
    <aside class="flex h-full w-[380px] shrink-0 flex-col border-l border-line bg-panel">
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
        <Show when={jarvis.conversationId()}>
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
