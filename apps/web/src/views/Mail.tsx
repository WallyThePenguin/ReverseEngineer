// Mail: every account's conversations in one list, split into Signal and Noise, plus what needs
// your reply and what you're waiting on. j/k to move, Enter to open, e archive, s star, u read or
// unread, n send the sender to the other lane, d no reply needed, # trash. Changes show at once
// and reach Gmail within a minute.

import { createSignal, For, Show } from "solid-js";
import { Badge, Button, Empty, PaneHeader } from "../components/ui.tsx";
import { debounced } from "../lib/debounce.ts";
import { ago } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { MailAccount, MailAddress, MailDraft, MailThread } from "../lib/types.ts";
import { Composer } from "./MailCompose.tsx";
import { MailSyncBanner } from "./MailSyncStatus.tsx";

type View = "inbox" | "starred" | "sent" | "all" | "trash";

export const named = (a: MailAddress | undefined) => a?.name || a?.address || "someone";

export function Mail(props: { pane: number }) {
  const [view, setView] = createSignal<View>("inbox");
  const [lane, setLane] = createSignal<"signal" | "noise" | "reply" | "waiting">("signal");
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const accounts = useAction<MailAccount[]>("mail.accounts");
  // What's searched for: what's typed, once typing pauses.
  const term = debounced(query);
  const searching = () => term().trim().length > 0;
  const listed = useAction<MailThread[]>(
    "mail.threads",
    () => {
      if (view() !== "inbox") return { view: view(), limit: 100 };
      if (lane() === "reply") return { view: "inbox", waiting: "you", limit: 100 };
      if (lane() === "waiting") return { view: "all", waiting: "them", limit: 100 };
      return { view: "inbox", lane: lane(), limit: 100 };
    },
    () => !searching(),
  );
  const found = useAction<MailThread[]>("mail.search", () => ({ query: term().trim() }), searching);
  const threads = {
    get data() {
      return searching() ? found.data : listed.data;
    },
    get isLoading() {
      return searching() ? found.isLoading : listed.isLoading;
    },
  };
  const list = () => threads.data ?? [];
  const drafts = useAction<MailDraft[]>("mail.drafts");
  // New messages (not replies) are written here, above the list.
  const fresh = () => (drafts.data ?? []).filter((d) => !d.threadId).map((d) => d.id);
  const compose = () => void act("mail.draft", { text: "" });
  const current = () => list()[Math.min(index(), list().length - 1)];
  const focused = () => layout.focused() === props.pane;

  const open = (t: MailThread | undefined, beside = false) => {
    if (!t) return;
    if (t.unread) void act("mail.mark_read", { ids: [t.id] });
    const route = { view: "thread" as const, id: t.id };
    if (beside) layout.open(route, { beside: true });
    else layout.show(route, props.pane);
  };
  const run = async (name: string, input: Record<string, unknown>, done?: string) => {
    if ((await act(name, input)) && done) toast.show(done);
  };
  const otherLane = async (t: MailThread | undefined) => {
    const from = t?.participants.find((p) => p.address !== t.account);
    if (!t || !from) return;
    const to = t.lane === "noise" ? "signal" : "noise";
    await run(
      "mail.set_lane",
      { sender: from.address, lane: to },
      `Mail from ${from.address} goes to ${to === "noise" ? "Noise" : "Signal"} now.`,
    );
  };

  useHotkeys([
    ...listKeys({ count: () => list().length, index, setIndex, when: focused }),
    { keys: "enter", run: () => open(current()), when: focused, label: "Open" },
    { keys: "o", run: () => open(current()), when: focused },
    {
      keys: "e",
      run: () => {
        const t = current();
        if (t) void run(t.inInbox ? "mail.archive" : "mail.unarchive", { ids: [t.id] });
      },
      when: focused,
      label: "Archive",
    },
    {
      keys: "s",
      run: () =>
        current() && void run("mail.star", { ids: [current()!.id], starred: !current()!.starred }),
      when: focused,
      label: "Star",
    },
    {
      keys: "u",
      run: () =>
        current() && void run("mail.mark_read", { ids: [current()!.id], read: current()!.unread }),
      when: focused,
      label: "Read or unread",
    },
    {
      keys: "n",
      run: () => void otherLane(current()),
      when: focused,
      label: "Sender to Signal or Noise",
    },
    {
      keys: "d",
      run: () => {
        const t = current();
        if (t?.waiting) void run("mail.no_reply", { ids: [t.id] }, "Marked as needing no reply.");
      },
      when: focused,
      label: "No reply needed",
    },
    { keys: "c", run: compose, when: focused, label: "Write an email" },
    {
      keys: "#",
      run: () =>
        current() && void run("mail.trash", { ids: [current()!.id] }, "Moved to the trash."),
      when: focused,
      label: "Trash",
    },
  ]);

  const tab = (active: boolean) =>
    `rounded-md px-2 py-1 text-sm ${active ? "bg-sunk font-medium" : "text-muted hover:text-ink"}`;
  const syncing = () => (accounts.data ?? []).some((a) => !a.firstSyncDone);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Mail">
        <Show when={view() === "inbox" && !query()}>
          <button type="button" class={tab(lane() === "signal")} onClick={() => setLane("signal")}>
            Signal
          </button>
          <button type="button" class={tab(lane() === "noise")} onClick={() => setLane("noise")}>
            Noise
          </button>
          <button type="button" class={tab(lane() === "reply")} onClick={() => setLane("reply")}>
            To reply
          </button>
          <button
            type="button"
            class={tab(lane() === "waiting")}
            onClick={() => setLane("waiting")}
          >
            Waiting
          </button>
          <span class="mx-1 h-4 w-px bg-line" />
        </Show>
        <select
          class="rounded-md border border-line bg-panel px-2 py-1 text-sm"
          aria-label="Which mail"
          value={view()}
          onChange={(e) => {
            setView(e.currentTarget.value as View);
            setIndex(0);
          }}
        >
          <option value="inbox">Inbox</option>
          <option value="starred">Starred</option>
          <option value="sent">Sent</option>
          <option value="all">All mail</option>
          <option value="trash">Trash</option>
        </select>
        <Button small kind="primary" onClick={compose}>
          Write
        </Button>
        <input
          class="w-36 rounded-md border border-line bg-panel px-2 py-1 text-sm"
          type="search"
          placeholder="Search mail"
          aria-label="Search mail"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
        />
      </PaneHeader>
      <MailSyncBanner accounts={accounts.data ?? []} />
      <div class="flex-1 overflow-auto">
        <Show when={fresh().length > 0}>
          <div class="space-y-3 border-b border-line p-4">
            <For each={fresh()}>
              {(id) => <Composer draft={(drafts.data ?? []).find((d) => d.id === id)!} />}
            </For>
          </div>
        </Show>
        <Show
          when={(accounts.data ?? []).length > 0 || accounts.isLoading}
          fallback={<Empty>No mail account yet. Connect Gmail in Settings.</Empty>}
        >
          <Show when={!threads.isLoading} fallback={<Empty>Loading…</Empty>}>
            <Show
              when={list().length > 0}
              fallback={
                <Empty>
                  {syncing()
                    ? "Bringing in your mail…"
                    : query()
                      ? "No mail matches that."
                      : "Nothing here."}
                </Empty>
              }
            >
              <ul>
                <For each={list()}>
                  {(t, i) => (
                    <li
                      class="cursor-pointer border-b border-line px-4 py-2.5"
                      data-active={focused() && i() === index()}
                      onClick={(e) => {
                        setIndex(i());
                        open(t, e.shiftKey);
                      }}
                    >
                      <div class="flex items-baseline gap-3">
                        <span
                          class={`mt-1.5 size-2 shrink-0 self-start rounded-full ${t.unread ? "bg-accent" : "bg-transparent"}`}
                        />
                        <span
                          class={`w-40 shrink-0 truncate text-sm ${t.unread ? "font-semibold" : ""}`}
                        >
                          {t.participants
                            .filter((p) => p.address !== t.account)
                            .map(named)
                            .join(", ") || "me"}
                          <Show when={t.messageCount > 1}>
                            <span class="text-faint"> {t.messageCount}</span>
                          </Show>
                        </span>
                        <span class="min-w-0 flex-1 truncate text-sm">
                          <span class={t.unread ? "font-semibold" : ""}>{t.subject}</span>
                          <span class="text-muted"> · {t.snippet}</span>
                        </span>
                        <Show when={t.starred}>
                          <span class="text-warn" title="Starred">
                            ★
                          </span>
                        </Show>
                        <Show when={view() !== "inbox" && t.inInbox}>
                          <Badge tone="muted">inbox</Badge>
                        </Show>
                        <Show when={t.waiting === "you" && lane() !== "reply"}>
                          <Badge tone="jarvis">reply</Badge>
                        </Show>
                        <Show when={t.waiting === "them" && lane() === "waiting"}>
                          <Badge tone="muted">no answer yet</Badge>
                        </Show>
                        <span class="shrink-0 text-xs text-faint">{ago(t.lastMessageAt)}</span>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
