// The left rail: where you are, what's waiting, and whether the live connection is up.

import { createRoot, createSignal, For, Show } from "solid-js";
import { JarvisDot, jarvis } from "../jarvis/JarvisPane.tsx";
import { authPost } from "../lib/api.ts";
import { PLACES } from "../lib/apps.ts";
import { okToSignOut } from "../lib/docStore.ts";
import { MOD } from "../lib/hotkeys.ts";
import { live } from "../lib/live.ts";
import { type ListView, layout } from "../lib/panes.ts";
import { inboxInput, useAction } from "../lib/query.ts";
import type { Approval, InboxRow } from "../lib/types.ts";

/** Whether the sidebar is tucked away on a computer (it gives the panes room), remembered. */
export const sidebar = createRoot(() => {
  const read = () => {
    try {
      return localStorage.getItem("hearth.sidebarHidden") === "1";
    } catch {
      return false;
    }
  };
  const [hidden, setHidden] = createSignal(read());
  return {
    hidden,
    toggle(next = !hidden()) {
      setHidden(next);
      try {
        localStorage.setItem("hearth.sidebarHidden", next ? "1" : "0");
      } catch {}
    },
  };
});

/** What shows when the sidebar is hidden: a button to bring it back. */
export function SidebarRail() {
  return (
    <div class="flex shrink-0 flex-col items-center border-r border-line bg-sunk/50 py-3">
      <button
        type="button"
        class="rounded-md px-2 py-1 text-muted hover:bg-panel hover:text-ink"
        aria-label="Show the sidebar"
        title={`Show the sidebar (${MOD}+B)`}
        onClick={() => sidebar.toggle(false)}
      >
        »
      </button>
      <span
        class={`mt-3 size-1.5 rounded-full ${live.connected() ? "bg-ok" : "bg-faint"}`}
        title={live.connected() ? "Live" : "Reconnecting…"}
      />
    </div>
  );
}

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
        <span class="flex-1" />
        <Show when={!props.onPicked}>
          <button
            type="button"
            class="rounded px-1.5 text-muted hover:bg-panel hover:text-ink"
            aria-label="Hide the sidebar"
            title={`Hide the sidebar (${MOD}+B)`}
            onClick={() => sidebar.toggle(true)}
          >
            «
          </button>
        </Show>
      </div>
      <button
        type="button"
        class="mb-3 flex items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5 text-left text-sm text-muted"
        onClick={props.onPalette}
      >
        <span class="flex-1">Search or ask…</span>
        <span class="hidden text-xs md:inline">{MOD === "⌘" ? "⌘K" : "Ctrl K"}</span>
      </button>
      <ul class="min-h-0 space-y-0.5 overflow-y-auto">
        <For each={PLACES}>
          {(item) => (
            <li>
              <button
                type="button"
                class={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm md:min-h-0 ${current() === item.view ? "bg-panel font-medium shadow-sm" : "text-muted hover:text-ink"}`}
                aria-current={current() === item.view ? "page" : undefined}
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
                  <span class="rounded-full bg-accent px-1.5 text-micro font-semibold text-on-fill">
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
        class={`mb-1 min-h-11 rounded-md px-2 py-1.5 text-left text-sm md:min-h-0 ${jarvis.open() ? "text-jarvis" : "text-muted hover:text-ink"}`}
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
        class="min-h-11 rounded-md px-2 py-1.5 text-left text-sm text-muted hover:text-ink md:min-h-0"
        onClick={async () => {
          // Signing out deletes this device's copies, edits Hearth hasn't got included.
          if (!(await okToSignOut())) return;
          await authPost("logout").catch(() => {});
          props.onSignOut();
        }}
      >
        Sign out
      </button>
    </nav>
  );
}
