// One email conversation: its messages (mail/Message.tsx), drafts of replies, and what you can do
// with it. Archiving it on a computer moves on to the next conversation in the list it was opened
// from; on a phone it goes back to the list. t makes a task that links back to it.

import { createSignal, For, Show, useContext } from "solid-js";
import { ActionBar } from "../components/ActionBar.tsx";
import { Backlinks } from "../components/Backlinks.tsx";
import { Button, PaneContext, PaneHeader, Placeholder } from "../components/ui.tsx";
import { useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { archive, makeTask, nextInList, reply as replyTo, showThread } from "../lib/mailActions.ts";
import { narrow } from "../lib/narrow.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { MailDraft, MailMessage, MailThreadView } from "../lib/types.ts";
import { Composer } from "./MailCompose.tsx";
import { Message } from "./mail/Message.tsx";

export function MailThreadPane(props: { id: string; pane: number }) {
  const t = useAction<MailThreadView>("mail.thread", () => ({ id: props.id }));
  // Asked for alongside the conversation, not after it. The id opened is almost always the
  // conversation's own; when it's one of its messages', this asks again once that's known.
  const drafts = useAction<MailDraft[]>("mail.drafts", () => ({
    threadId: t.data?.id ?? props.id,
  }));
  const draftIds = () => (drafts.data ?? []).map((d) => d.id);
  const reply = (all: boolean) => t.data && void replyTo(t.data.id, drafts.data ?? [], all);
  const task = () => t.data && void makeTask(t.data);
  const [opened, setOpened] = createSignal<Set<string>>(new Set());
  const focused = () => layout.focused() === props.pane;
  const pane = useContext(PaneContext);
  // The newest message and any unread ones start open.
  const isOpen = (m: MailMessage, last: boolean) => last || m.unread || opened().has(m.id);
  const toggle = (id: string) =>
    setOpened((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = async (name: string, input: Record<string, unknown>, done?: string) => {
    if ((await act(name, input)) && done) toast.show(done);
  };
  // Archived: the next conversation takes its place at once (the list drops this one at once too),
  // or on a phone, or when it wasn't opened from a list, it closes.
  const archiveOrBack = () => {
    const v = t.data;
    if (!v) return;
    if (!v.inInbox) return void run("mail.unarchive", { ids: [v.id] }, "Back in the inbox.");
    const next = narrow() ? undefined : nextInList(v.id);
    void archive(v.id);
    if (next) showThread(next, props.pane);
    else pane.close?.();
  };
  useHotkeys([
    { keys: "e", run: archiveOrBack, when: focused, label: "Archive" },
    { keys: "t", run: task, when: focused, label: "Make task" },
    {
      keys: "s",
      run: () => t.data && void run("mail.star", { ids: [t.data.id], starred: !t.data.starred }),
      when: focused,
      label: "Star",
    },
    { keys: "r", run: () => reply(false), when: focused, label: "Reply" },
    { keys: "a", run: () => reply(true), when: focused, label: "Reply all" },
  ]);
  return (
    <Show when={t.data} fallback={<Placeholder query={t} what="conversation" />}>
      {(v) => (
        <div class="flex h-full flex-col">
          <PaneHeader
            title={v().subject}
            sub={`${v().account} · ${v().messageCount} message${v().messageCount === 1 ? "" : "s"} · ${v().lane === "noise" ? "Noise" : "Signal"}${v().waiting === "you" ? " · needs your reply" : v().waiting === "them" ? " · waiting on them" : ""}`}
          >
            <Button small onClick={archiveOrBack}>
              {v().inInbox ? "Archive" : "Move to inbox"}
            </Button>
            {/* A phone has it in the bar along the bottom. */}
            <Show when={!narrow()}>
              <Button small onClick={task}>
                Make task
              </Button>
            </Show>
            <Button
              small
              onClick={() => void run("mail.star", { ids: [v().id], starred: !v().starred })}
            >
              {v().starred ? "Unstar" : "Star"}
            </Button>
            <Show when={v().waiting}>
              <Button
                small
                onClick={() => void run("mail.no_reply", { ids: [v().id] }, "No reply needed.")}
              >
                No reply needed
              </Button>
            </Show>
          </PaneHeader>
          <div class="flex-1 space-y-3 overflow-auto px-5 py-4">
            <For each={v().messages}>
              {(m, i) => (
                <Message
                  m={m}
                  open={isOpen(m, i() === v().messages.length - 1)}
                  onToggle={() => toggle(m.id)}
                />
              )}
            </For>
            {/* Keyed by id, so a draft being typed in isn't redrawn when it saves. */}
            <For each={draftIds()}>
              {(id) => (
                <Composer
                  draft={(drafts.data ?? []).find((d) => d.id === id)!}
                  conversation={v().subject}
                />
              )}
            </For>
            <div class="flex gap-2">
              <Button small onClick={() => reply(false)}>
                Reply
              </Button>
              <Button small onClick={() => reply(true)}>
                Reply all
              </Button>
            </div>
            <Backlinks id={v().id} />
          </div>
          {/* On a phone: triage with the thumb, then back to the list. */}
          <ActionBar
            label="Conversation actions"
            actions={[
              { label: v().inInbox ? "Archive" : "To inbox", run: archiveOrBack },
              {
                label: v().starred ? "Unstar" : "Star",
                on: v().starred,
                run: () => void run("mail.star", { ids: [v().id], starred: !v().starred }),
              },
              { label: "Reply", run: () => reply(false) },
              { label: "Make task", run: task },
              {
                label: "Trash",
                run: async () => {
                  if (!(await act("mail.trash", { ids: [v().id] }))) return;
                  toast.show("Moved to the trash.");
                  pane.close?.();
                },
              },
            ]}
          />
        </div>
      )}
    </Show>
  );
}
