// The left rail: Hearth's seven places (Today and six sub-products), where you are, what's waiting
// on you, and whether the live connection is up. Settings sits at the bottom, with Jarvis's chat.

import { createRoot, createSignal, For, type JSX, Show } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { Flame } from "../components/Mark.tsx";
import { JarvisStatusMark, jarvis } from "../jarvis/JarvisPane.tsx";
import { authPost } from "../lib/api.ts";
import { APPS, type App, type AppId, appOf } from "../lib/apps.ts";
import { okToSignOut } from "../lib/docStore.ts";
import { MOD } from "../lib/hotkeys.ts";
import { live } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { inboxInput, useAction, usePendingApprovals } from "../lib/query.ts";
import type { InboxRow } from "../lib/types.ts";

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

/** A button in the sidebar's corner that shows only an icon. */
const CORNER =
  "flex size-7 items-center justify-center rounded-md text-muted hover:bg-panel hover:text-ink";

/** What shows when the sidebar is hidden: a button to bring it back. */
export function SidebarRail() {
  return (
    <div class="flex shrink-0 flex-col items-center border-r border-line bg-sunk/50 px-1.5 py-3">
      <button
        type="button"
        class={CORNER}
        aria-label="Show the sidebar"
        title={`Show the sidebar (${MOD}+B)`}
        onClick={() => sidebar.toggle(false)}
      >
        <Icon name="panel-left-open" size={18} />
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
  const approvals = usePendingApprovals();
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
  const current = () => {
    const view = layout.panes()[layout.focused()]?.view;
    return view ? appOf(view).id : undefined;
  };

  // Today counts what's waiting for your yes or a look; Mail, the replies you owe.
  const count = (id: AppId) => {
    if (id === "today") return waiting() || null;
    if (id === "mail") return mail.data?.toReply || null;
    return null;
  };

  /** Opens a place at its home, beside on shift-click; on a phone, in place of what's there. */
  const go = (app: App, beside: boolean) => {
    const route = { view: app.views[0]! };
    if (props.onPicked) {
      jarvis.toggle(false);
      layout.reset(route);
      props.onPicked();
    } else layout.open(route, { beside });
  };

  const row = (app: App): JSX.Element => (
    <button
      type="button"
      // Its icon takes its sub-product's colour while it's the place you're in.
      data-product={app.hue ? app.id : undefined}
      class={`group flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm md:min-h-0 ${current() === app.id ? "bg-panel font-medium shadow-sm" : "text-muted hover:text-ink"}`}
      aria-current={current() === app.id ? "page" : undefined}
      onClick={(e) => go(app, e.shiftKey)}
    >
      {app.icon === "mark" ? (
        <JarvisStatusMark />
      ) : (
        <Icon
          name={app.icon}
          class={current() === app.id ? "text-hue" : "text-faint group-hover:text-muted"}
        />
      )}
      <span class="flex-1">{app.label}</span>
      <Show when={count(app.id)}>
        <span class="rounded-full bg-accent px-1.5 text-micro font-semibold text-on-fill tabular-nums">
          {count(app.id)}
        </span>
      </Show>
    </button>
  );

  return (
    <nav class="flex h-full w-52 shrink-0 flex-col border-r border-line bg-sunk/50 px-2 py-3">
      <div class="mb-3 flex min-h-7 items-center gap-2 px-2">
        <Flame size={20} />
        <span class="font-semibold">Hearth</span>
        <span
          class={`size-1.5 rounded-full ${live.connected() ? "bg-ok" : "bg-faint"}`}
          title={live.connected() ? "Live" : "Reconnecting…"}
        />
        <span class="flex-1" />
        <Show when={!props.onPicked}>
          <button
            type="button"
            class={`-mr-1 ${CORNER}`}
            aria-label="Hide the sidebar"
            title={`Hide the sidebar (${MOD}+B)`}
            onClick={() => sidebar.toggle(true)}
          >
            <Icon name="panel-left-close" size={18} />
          </button>
        </Show>
      </div>
      <button
        type="button"
        class="mb-3 flex items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5 text-left text-sm text-muted"
        onClick={props.onPalette}
      >
        <Icon name="search" />
        <span class="flex-1">Search or ask…</span>
        <span class="hidden text-xs md:inline">{MOD === "⌘" ? "⌘K" : "Ctrl K"}</span>
      </button>
      <ul class="min-h-0 space-y-0.5 overflow-y-auto">
        <For each={APPS.filter((a) => !a.utility)}>{(app) => <li>{row(app)}</li>}</For>
      </ul>
      <div class="flex-1" />
      <For each={APPS.filter((a) => a.utility)}>{(app) => <div class="mb-1">{row(app)}</div>}</For>
      <button
        type="button"
        class={`mb-1 flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm md:min-h-0 ${jarvis.open() ? "text-ink" : "text-muted hover:text-ink"}`}
        onClick={() => {
          jarvis.toggle();
          props.onPicked?.();
        }}
        title="Ctrl+J"
      >
        {/* Jarvis's chat, at the side: the Jarvis row above is what it did and knows. */}
        <Icon name="panel-right" class="text-faint" />
        {jarvis.open() ? "Hide Jarvis" : "Ask Jarvis"}
      </button>
      <button
        type="button"
        class="flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-muted hover:text-ink md:min-h-0"
        onClick={async () => {
          // Signing out deletes this device's copies, edits Hearth hasn't got included.
          if (!(await okToSignOut())) return;
          await authPost("logout").catch(() => {});
          props.onSignOut();
        }}
      >
        <Icon name="log-out" class="text-faint" />
        Sign out
      </button>
    </nav>
  );
}
