// The left rail: where you are, what's waiting, and whether the live connection is up.

import { For, Show } from "solid-js";
import { JarvisDot, jarvis } from "../jarvis/JarvisPane.tsx";
import { authPost } from "../lib/api.ts";
import { live } from "../lib/live.ts";
import { type ListView, layout } from "../lib/panes.ts";
import { inboxInput, useAction } from "../lib/query.ts";
import type { Approval, InboxRow } from "../lib/types.ts";

const NAV: { view: ListView; label: string; keys: string }[] = [
  { view: "inbox", label: "Inbox", keys: "g i" },
  { view: "mail", label: "Mail", keys: "g e" },
  { view: "tasks", label: "Tasks", keys: "g t" },
  { view: "notes", label: "Notes", keys: "g n" },
  { view: "calendar", label: "Calendar", keys: "g c" },
  { view: "canvases", label: "Canvas", keys: "g w" },
  { view: "sheets", label: "Spreadsheets", keys: "g x" },
  { view: "people", label: "People", keys: "g p" },
  { view: "memory", label: "Memory", keys: "g m" },
  { view: "voice", label: "Voice", keys: "g v" },
  { view: "browser", label: "Browser", keys: "g b" },
  { view: "activity", label: "Jarvis's activity", keys: "g a" },
  { view: "settings", label: "Settings", keys: "g s" },
];

/** What's waiting for you: unseen inbox items and approvals, each approval once (its inbox
 * card and the approval itself are the same thing). */
export function useWaiting() {
  const inbox = useAction<InboxRow[]>("inbox.list", () => inboxInput("live", "signal"));
  const approvals = useAction<Approval[]>("approval.list", () => ({
    status: "pending",
    limit: 50,
  }));
  return () => {
    const pending = new Set((approvals.data ?? []).map((a) => a.id));
    const unseen = (inbox.data ?? []).filter(
      (r) =>
        r.notification.state === "unseen" &&
        !(r.notification.approvalId && pending.has(r.notification.approvalId)),
    );
    return unseen.length + pending.size;
  };
}

export function Sidebar(props: {
  onPalette: () => void;
  onSignOut: () => void;
  /** On a phone the menu is a drawer that closes once you pick something. */
  onPicked?: () => void;
}) {
  const waiting = useWaiting();
  const mail = useAction<{ unread: number; toReply: number }>("mail.counts");
  const current = () => layout.panes()[layout.focused()]?.view;

  const count = (view: ListView) => {
    if (view === "inbox") return waiting() || null;
    if (view === "mail") return mail.data?.unread || null;
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
                onClick={(e) => {
                  if (props.onPicked) {
                    jarvis.toggle(false);
                    layout.reset({ view: item.view });
                    props.onPicked();
                  } else layout.open({ view: item.view }, { beside: e.shiftKey });
                }}
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
        onClick={() => {
          jarvis.toggle();
          props.onPicked?.();
        }}
        title="Ctrl+J"
      >
        {jarvis.open() ? "Hide Jarvis" : "Show Jarvis"}
        <JarvisDot />
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
