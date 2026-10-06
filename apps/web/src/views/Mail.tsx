// Mail: every account's conversations in one list, split into Signal and Noise, plus what needs
// your reply and what you're waiting on. j/k to move, Enter to open, e archive, r reply, t make a
// task, s star, u read or unread, n send the sender to the other lane, d no reply needed, # trash.
// Pointing at a row shows Archive, Make task and Reply. Changes show at once and reach Gmail
// within a minute. Older conversations load as you scroll down to them. One with a reply drafted
// says so, and whether Jarvis wrote it.

import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { IconButton } from "../components/kit/IconButton.tsx";
import { Pill } from "../components/kit/Pill.tsx";
import { Skeleton } from "../components/kit/Skeleton.tsx";
import { Badge, Button, Empty, PaneHeader } from "../components/ui.tsx";
import { debounced } from "../lib/debounce.ts";
import { ago } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { archive, listClosed, makeTask, openedFrom, reply } from "../lib/mailActions.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { createSelection } from "../lib/selection.ts";
import type { MailAccount, MailAddress, MailDraft, MailThread } from "../lib/types.ts";
import { Composer } from "./MailCompose.tsx";
import { PAGE, useThreadPages, whenSeen } from "./MailPages.ts";
import { MailSyncBanner } from "./MailSyncStatus.tsx";

type View = "inbox" | "starred" | "sent" | "all" | "trash";

export const named = (a: MailAddress | undefined) => a?.name || a?.address || "someone";

type Lane = "signal" | "noise" | "reply" | "waiting";
/** A lane Mail was asked to open on from elsewhere, and in which pane, until that pane does. */
const [asked, setAsked] = createSignal<{ lane: Lane; pane: number } | null>(null);

/**
 * Opens Mail beside pane `from` on the conversations that need your reply (Today's "All" under
 * Replies you owe). Only that Mail pane turns to them; any other Mail pane stays as it is.
 */
export function openToReply(from: number) {
  layout.show({ view: "mail" }, from);
  // Where show put it: the pane to the right, or the last one when there's no room for another.
  setAsked({ lane: "reply", pane: Math.min(from + 1, layout.panes().length - 1) });
}

export function Mail(props: { pane: number }) {
  const [view, setView] = createSignal<View>("inbox");
  // Asked before this pane was drawn: it opens on that lane.
  const mine = untrack(() => {
    const a = asked();
    return a?.pane === props.pane ? a : null;
  });
  if (mine) setAsked(null);
  const [lane, setLane] = createSignal<Lane>(mine?.lane ?? "signal");
  const [query, setQuery] = createSignal("");
  const accounts = useAction<MailAccount[]>("mail.accounts");
  // What's searched for: what's typed, once typing pauses.
  const term = debounced(query);
  const searching = () => term().trim().length > 0;
  const listed = useThreadPages(
    () => {
      if (view() !== "inbox") return { view: view(), limit: PAGE };
      if (lane() === "reply") return { view: "inbox", waiting: "you", limit: 100 };
      if (lane() === "waiting") return { view: "all", waiting: "them", limit: 100 };
      return { view: "inbox", lane: lane(), limit: PAGE };
    },
    () => !searching(),
  );
  const found = useAction<MailThread[]>("mail.search", () => ({ query: term().trim() }), searching);
  const threads = {
    get data() {
      return searching() ? found.data : listed.list();
    },
    get isLoading() {
      return searching() ? found.isLoading : listed.query.isLoading;
    },
  };
  const list = () => threads.data ?? [];
  const paging = () => !searching() && listed.query.hasNextPage;
  const drafts = useAction<MailDraft[]>("mail.drafts");
  // New messages (not replies) are written here, above the list.
  const fresh = () => (drafts.data ?? []).filter((d) => !d.threadId).map((d) => d.id);
  // Conversations with a reply waiting to go, and who wrote the newest one.
  const drafted = createMemo(() => {
    const by = new Map<string, MailDraft["by"]>();
    for (const d of drafts.data ?? [])
      if (d.threadId && !by.has(d.threadId)) by.set(d.threadId, d.by);
    return by;
  });
  const compose = () => void act("mail.draft", { text: "" });
  // Kept by id: new mail arriving above doesn't move e or # onto a different conversation.
  const sel = createSelection(list, (t) => t.id);
  const current = sel.current;
  // Moving down with j: the next page comes before you reach the end.
  createEffect(() => {
    if (paging() && sel.index() >= list().length - 5) listed.more();
  });
  // Asked while it's open, as this pane: it turns to that lane.
  createEffect(() => {
    const to = asked();
    if (!to || to.pane !== props.pane) return;
    setAsked(null);
    setView("inbox");
    setQuery("");
    setLane(to.lane);
    sel.reset();
  });
  const focused = () => layout.focused() === props.pane;

  const open = (t: MailThread | undefined, beside = false) => {
    if (!t) return;
    if (t.unread) void act("mail.mark_read", { ids: [t.id] });
    // Archiving it there moves on to the next one in this list.
    openedFrom(list, t.id);
    const route = { view: "thread" as const, id: t.id };
    if (beside) layout.open(route, { beside: true });
    else layout.show(route, props.pane);
  };
  onCleanup(() => listClosed(list));
  // Reply from the list: the conversation opens with the cursor in the reply.
  const replyFrom = (t: MailThread | undefined) => {
    if (!t) return;
    open(t);
    void reply(t.id, drafts.data ?? []);
  };
  const archiveRow = (t: MailThread | undefined) => {
    if (!t) return;
    if (t.inInbox) void archive(t.id);
    else void run("mail.unarchive", { ids: [t.id] }, "Back in the inbox.");
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
    ...listKeys({
      count: () => list().length,
      index: sel.index,
      setIndex: sel.select,
      when: focused,
    }),
    { keys: "enter", run: () => open(current()), when: focused, label: "Open" },
    { keys: "o", run: () => open(current()), when: focused },
    { keys: "e", run: () => archiveRow(current()), when: focused, label: "Archive" },
    { keys: "r", run: () => replyFrom(current()), when: focused, label: "Reply" },
    {
      keys: "t",
      run: () => current() && void makeTask(current()!),
      when: focused,
      label: "Make task",
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
            sel.reset();
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
            sel.reset();
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
          <Show when={!threads.isLoading} fallback={<Skeleton />}>
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
                      class="group cursor-pointer border-b border-line px-4 py-2.5"
                      data-active={focused() && i() === sel.index()}
                      onClick={(e) => {
                        sel.select(i());
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
                          <span class="self-center text-warn" title="Starred">
                            <Icon name="star" size={14} filled label="Starred" />
                          </span>
                        </Show>
                        <Show when={view() !== "inbox" && t.inInbox}>
                          <Badge tone="muted">inbox</Badge>
                        </Show>
                        <Show when={drafted().get(t.id)}>
                          {(by) => (
                            <Pill
                              tone={by() === "jarvis" ? "jarvis" : "neutral"}
                              icon="reply"
                              class="self-center"
                            >
                              {by() === "jarvis" ? "Jarvis drafted" : "Draft"}
                            </Pill>
                          )}
                        </Show>
                        <Show when={t.waiting === "you" && lane() !== "reply"}>
                          <Badge tone="jarvis">reply</Badge>
                        </Show>
                        <Show when={t.waiting === "them" && lane() === "waiting"}>
                          <Badge tone="muted">no answer yet</Badge>
                        </Show>
                        <span class="shrink-0 text-xs text-faint md:group-hover:hidden">
                          {ago(t.lastMessageAt)}
                        </span>
                        {/* Pointing at a row on a computer; a phone has the open email's bar. */}
                        <span
                          class="-my-1.5 hidden shrink-0 self-center md:group-hover:flex"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <IconButton
                            icon="archive"
                            label={t.inInbox ? "Archive" : "Move to inbox"}
                            title={t.inInbox ? "Archive (e)" : "Move to inbox (e)"}
                            size={16}
                            onClick={() => archiveRow(t)}
                          />
                          <IconButton
                            icon="tasks"
                            label="Make task"
                            title="Make task (t)"
                            size={16}
                            onClick={() => void makeTask(t)}
                          />
                          <IconButton
                            icon="reply"
                            label="Reply"
                            title="Reply (r)"
                            size={16}
                            onClick={() => {
                              sel.select(i());
                              replyFrom(t);
                            }}
                          />
                        </span>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={paging()}>
                <div class="p-3 text-center" ref={(el) => onCleanup(whenSeen(el, listed.more))}>
                  <Button
                    small
                    disabled={listed.query.isFetchingNextPage}
                    onClick={() => listed.more()}
                  >
                    {listed.query.isFetchingNextPage ? "Loading…" : "Older conversations"}
                  </Button>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
