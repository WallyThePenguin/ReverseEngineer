// The left rail: where you are, what's waiting, and whether the live connection is up.

import { For, Show } from "solid-js";
import { jarvis } from "../jarvis/JarvisPane.tsx";
import { authPost } from "../lib/api.ts";
import { live } from "../lib/live.ts";
import { type ListView, layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import type { Approval, InboxRow } from "../lib/types.ts";

const NAV: { view: ListView; label: string; keys: string }[] = [
  { view: "inbox", label: "Inbox", keys: "g i" },
  { view: "mail", label: "Mail", keys: "g e" },
  { view: "tasks", label: "Tasks", keys: "g t" },
  { view: "notes", label: "Notes", keys: "g n" },
  { view: "calendar", label: "Calendar", keys: "g c" },
  { view: "people", label: "People", keys: "g p" },
  { view: "memory", label: "Memory", keys: "g m" },
  { view: "browser", label: "Browser", keys: "g b" },
  { view: "activity", label: "Jarvis's activity", keys: "g a" },
  { view: "settings", label: "Settings", keys: "g s" },
];

export function Sidebar(props: { onPalette: () => void; onSignOut: () => void }) {
  const inbox = useAction<InboxRow[]>("inbox.list", () => ({
    view: "live",
    lane: "signal",
    limit: 100,
  }));
  const approvals = useAction<Approval[]>("approval.list", () => ({
    status: "pending",
    limit: 50,
  }));
  const unseen = () => (inbox.data ?? []).filter((r) => r.notification.state === "unseen").length;
  const current = () => layout.panes()[layout.focused()]?.view;

  const count = (view: ListView) => {
    if (view === "inbox") return unseen() + (approvals.data?.length ?? 0) || null;
    return null;
  };

  return (
    <nav class="flex h-full w-52 shrink-0 flex-col border-r border-line bg-sunk/50 px-2 py-3">
      <div class="mb-3 flex items-center gap-2 px-2">
        <span class="font-semibold">Hearth</span>
        <span
          class={`size-1.5 rounded-full ${live.connected() ? "bg-ok" : "bg-faint"}`}
          title={live.connected() ? "Live" : "Reconnecting…"}
        />
      </div>
      <button
        type="button"
        class="mb-3 flex items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5 text-left text-sm text-muted"
        onClick={props.onPalette}
      >
        <span class="flex-1">Search or ask…</span>
        <span class="text-xs">Ctrl K</span>
      </button>
      <ul class="space-y-0.5">
        <For each={NAV}>
          {(item) => (
            <li>
              <button
                type="button"
                class={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${current() === item.view ? "bg-panel font-medium shadow-sm" : "text-muted hover:text-ink"}`}
                title={`${item.label} (${item.keys})`}
                onClick={(e) => layout.open({ view: item.view }, { beside: e.shiftKey })}
              >
                <span class="flex-1">{item.label}</span>
                <Show when={count(item.view)}>
                  <span class="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">
                    {count(item.view)}
                  </span>
                </Show>
              </button>
            </li>
          )}
        </For>
      </ul>
      <div class="flex-1" />
      <button
        type="button"
        class={`mb-1 rounded-md px-2 py-1.5 text-left text-sm ${jarvis.open() ? "text-jarvis" : "text-muted hover:text-ink"}`}
        onClick={() => jarvis.toggle()}
        title="Ctrl+J"
      >
        {jarvis.open() ? "Hide Jarvis" : "Show Jarvis"}
      </button>
      <button
        type="button"
        class="rounded-md px-2 py-1.5 text-left text-sm text-muted hover:text-ink"
        onClick={async () => {
          await authPost("logout").catch(() => {});
          props.onSignOut();
        }}
      >
        Sign out
      </button>
    </nav>
  );
}
