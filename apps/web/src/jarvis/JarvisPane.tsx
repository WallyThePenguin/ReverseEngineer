// Jarvis on every screen: a chat pane on the right (Ctrl+J), with your recent conversations.

import { createRoot, createSignal, For, Show } from "solid-js";
import { Overflow } from "../components/Menu.tsx";
import { Badge, Button } from "../components/ui.tsx";
import { debounced } from "../lib/debounce.ts";
import { ago, day, time } from "../lib/format.ts";
import { jarvisLiveness } from "../lib/jarvis-health.ts";
import { narrow } from "../lib/narrow.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import { moveToTrash } from "../lib/trash.ts";
import type { ConversationRow, SystemStatus } from "../lib/types.ts";
import { Conversation } from "./Conversation.tsx";
import { RenameInput, renameConversation } from "./Rename.tsx";

/** A clock for "since when", ticking often enough for a two-minute threshold. */
const clock = createRoot(() => {
  const [now, setNow] = createSignal(Date.now());
  window.setInterval(() => setNow(Date.now()), 15_000);
  return now;
});

/** Whether Jarvis is up and well, checked every minute as well as on every change (D54). */
function useLiveness() {
  const status = useAction<SystemStatus>(
    "system.status",
    () => ({}),
    () => true,
    () => 60_000,
  );
  return { status, liveness: () => jarvisLiveness(status.data, clock()) };
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

/** Moves a conversation to the trash; if it's the one showing, a new one starts. */
async function trashConversation(id: string) {
  if ((await moveToTrash(id)) && jarvis.conversationId() === id) jarvis.setConversationId(null);
}

export function JarvisPane() {
  const [search, setSearch] = createSignal("");
  const query = debounced(search);
  const conversations = useAction<ConversationRow[]>("conversation.list", () => ({
    limit: 20,
    ...(query().trim() ? { query: query().trim() } : {}),
  }));
  // The one showing, even when a search hides it from the list.
  const shown = useAction<ConversationRow[]>("conversation.list", () => ({ limit: 20 }));
  const { status, liveness } = useLiveness();
  const [picking, setPicking] = createSignal(false);
  /** The conversation being renamed, if any. */
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const current = () => (shown.data ?? []).find((c) => c.id === jarvis.conversationId());
  const rename = (id: string) => (title: string | null) => {
    setRenaming(null);
    if (title) void renameConversation(id, title);
  };

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
        <Show
          when={renaming() !== null && renaming() === current()?.id}
          fallback={
            <button
              type="button"
              class="min-h-11 min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm text-muted hover:bg-sunk md:min-h-0"
              onClick={() => setPicking(!picking())}
              title="Your conversations"
              aria-expanded={picking()}
            >
              {current()?.title ?? "New conversation"} ▾
            </button>
          }
        >
          <RenameInput value={current()!.title} onDone={rename(current()!.id)} />
        </Show>
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
        <Show when={current()}>
          {(c) => (
            <Overflow
              label="Conversation actions"
              items={[
                { label: "Rename", run: () => setRenaming(c().id) },
                {
                  label: "Move to trash",
                  danger: true,
                  run: () => void trashConversation(c().id),
                },
              ]}
            />
          )}
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
        <div class="border-b border-line">
          <input
            class="w-full border-b border-line bg-transparent px-3 py-2 text-sm outline-none placeholder:text-faint"
            type="search"
            aria-label="Find a conversation"
            placeholder="Find a conversation…"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Escape" && setPicking(false)}
          />
          <ul class="max-h-72 overflow-auto py-1">
            <For
              each={conversations.data ?? []}
              fallback={
                <li class="px-3 py-2 text-sm text-muted">
                  {conversations.isLoading ? "Loading…" : "No conversations match."}
                </li>
              }
            >
              {(c) => (
                <li class="flex items-center gap-1 pr-1 hover:bg-sunk">
                  <Show
                    when={renaming() === c.id}
                    fallback={
                      <button
                        type="button"
                        class="flex min-h-11 min-w-0 flex-1 items-baseline gap-2 px-3 py-1.5 text-left md:min-h-0"
                        onClick={() => {
                          jarvis.setConversationId(c.id);
                          setPicking(false);
                        }}
                      >
                        <span class="flex-1 truncate text-sm">{c.title || "Untitled"}</span>
                        <span class="text-xs text-faint">{ago(c.lastTurnAt ?? c.updatedAt)}</span>
                      </button>
                    }
                  >
                    <RenameInput
                      value={c.title}
                      onDone={rename(c.id)}
                      class="m-1 min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-sm"
                    />
                  </Show>
                  <Overflow
                    label={`Actions for ${c.title || "this conversation"}`}
                    items={[
                      { label: "Rename", run: () => setRenaming(c.id) },
                      {
                        label: "Move to trash",
                        danger: true,
                        run: () => void trashConversation(c.id),
                      },
                    ]}
                  />
                </li>
              )}
            </For>
          </ul>
        </div>
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
