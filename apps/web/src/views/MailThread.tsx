// One email conversation. HTML mail is shown in a sandboxed frame that runs no scripts and loads
// nothing from the internet (so senders can't see you opened it) until you ask for images.

import { createSignal, For, Show, useContext } from "solid-js";
import { ActionBar } from "../components/ActionBar.tsx";
import { Backlinks } from "../components/Backlinks.tsx";
import { Badge, Button, PaneContext, PaneHeader, Placeholder } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type {
  MailAddress,
  MailDraft,
  MailInvite,
  MailMessage,
  MailThreadView,
} from "../lib/types.ts";
import { named } from "./Mail.tsx";
import { Composer } from "./MailCompose.tsx";

const list = (xs: MailAddress[]) =>
  xs.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");

/** An HTML message in its own frame, sized to fit. The frame runs no scripts. */
function HtmlBody(props: { id: string }) {
  const [images, setImages] = createSignal(false);
  const [remote, setRemote] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  const loaded = () => {
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) return;
    frame.style.height = `${Math.min(doc.documentElement.scrollHeight + 4, 20000)}px`;
    setRemote(
      doc.querySelector('meta[name="hearth-remote-images"]')?.getAttribute("content") === "1",
    );
  };
  return (
    <div class="space-y-2">
      <Show when={remote() && !images()}>
        <p class="text-xs text-muted">
          Pictures from the internet are hidden, so the sender can't tell you opened this.{" "}
          <button type="button" class="underline" onClick={() => setImages(true)}>
            Show them
          </button>
        </p>
      </Show>
      {/* No scripts: same-origin only lets Hearth measure the height. */}
      <iframe
        ref={frame}
        title="Message"
        class="w-full rounded-md border border-line bg-white"
        style={{ height: "120px" }}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        src={`/api/mail/frame/${props.id}${images() ? "?images=1" : ""}`}
        onLoad={loaded}
      />
    </div>
  );
}

const ANSWERS = [
  { response: "accepted", label: "Going" },
  { response: "tentative", label: "Maybe" },
  { response: "declined", label: "Not going" },
] as const;

/** An invitation, shown as the event on your calendar, answered right here. */
function Invite(props: { invite: MailInvite }) {
  const ev = () => props.invite.event;
  const when = () => {
    const e = ev()!;
    const start = new Date(e.startsAt);
    return e.allDay
      ? start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
      : start.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  };
  const answer = (response: string) =>
    void act("calendar.respond", { id: ev()!.id, response }).then(
      (r) => r && toast.show("Answered. The organizer will see it."),
    );
  return (
    <div class="rounded-md border border-line bg-sunk px-3 py-2 text-sm">
      <Show
        when={props.invite.method !== "CANCEL"}
        fallback={
          <span>
            📅{" "}
            {props.invite.event?.cancelled
              ? `"${props.invite.event.title}" is cancelled on your calendar.`
              : "The sender says a meeting is cancelled. Your calendar doesn't show that."}
          </span>
        }
      >
        <Show when={ev()} fallback={<span>📅 An invitation that isn't on your calendar yet.</span>}>
          {(e) => (
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium">📅 {e().title}</span>
              <span class="text-muted">{when()}</span>
              <Show when={e().cancelled}>
                <Badge tone="bad">cancelled</Badge>
              </Show>
              <span class="flex-1" />
              <Show when={!e().cancelled && !e().selfOrganizer}>
                <For each={ANSWERS}>
                  {(a) => (
                    <Button
                      small
                      kind={e().response === a.response ? "primary" : undefined}
                      onClick={() => answer(a.response)}
                    >
                      {a.label}
                    </Button>
                  )}
                </For>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}

function Message(props: { m: MailMessage; open: boolean; onToggle: () => void }) {
  const files = () => props.m.attachments.filter((a) => !a.inline);
  return (
    <article class="rounded-lg border border-line">
      <button
        type="button"
        class="flex w-full items-baseline gap-3 px-4 py-2 text-left"
        onClick={props.onToggle}
      >
        <span class="font-medium">{props.m.outbound ? "You" : named(props.m.from)}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-muted">
          <Show
            when={!props.open}
            fallback={
              <>
                to {list(props.m.to)}
                {props.m.cc.length ? `, cc ${list(props.m.cc)}` : ""}
              </>
            }
          >
            {props.m.text.slice(0, 140)}
          </Show>
        </span>
        <span class="shrink-0 text-xs text-faint" title={new Date(props.m.sentAt).toLocaleString()}>
          {ago(props.m.sentAt)}
        </span>
      </button>
      <Show when={props.open}>
        <div class="space-y-3 px-4 pb-4">
          <Show when={props.m.invite}>{(i) => <Invite invite={i()} />}</Show>
          <Show
            when={props.m.hasHtml}
            fallback={<pre class="whitespace-pre-wrap font-sans text-sm">{props.m.text}</pre>}
          >
            <HtmlBody id={props.m.id} />
          </Show>
          <Show when={files().length > 0}>
            <ul class="flex flex-wrap gap-2 text-xs">
              <For each={files()}>
                {(a) => (
                  <li class="rounded border border-line bg-sunk px-2 py-1">
                    <a href={`/api/mail/attachment/${props.m.id}/${a.index}`} download={a.filename}>
                      📎 {a.filename}
                    </a>{" "}
                    <span class="text-faint">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </article>
  );
}

export function MailThreadPane(props: { id: string; pane: number }) {
  const t = useAction<MailThreadView>("mail.thread", () => ({ id: props.id }));
  // Asked for alongside the conversation, not after it. The id opened is almost always the
  // conversation's own; when it's one of its messages', this asks again once that's known.
  const drafts = useAction<MailDraft[]>("mail.drafts", () => ({
    threadId: t.data?.id ?? props.id,
  }));
  const draftIds = () => (drafts.data ?? []).map((d) => d.id);
  const reply = (all: boolean) =>
    t.data && void act("mail.draft", { threadId: t.data.id, replyAll: all, text: "" });
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
  useHotkeys([
    {
      keys: "e",
      run: () =>
        t.data &&
        void run(
          t.data.inInbox ? "mail.archive" : "mail.unarchive",
          { ids: [t.data.id] },
          t.data.inInbox ? "Archived." : "Back in the inbox.",
        ),
      when: focused,
      label: "Archive",
    },
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
            <Button
              small
              onClick={() =>
                void run(
                  v().inInbox ? "mail.archive" : "mail.unarchive",
                  { ids: [v().id] },
                  v().inInbox ? "Archived." : "Back in the inbox.",
                )
              }
            >
              {v().inInbox ? "Archive" : "Move to inbox"}
            </Button>
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
              {(id) => <Composer draft={(drafts.data ?? []).find((d) => d.id === id)!} />}
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
              {
                label: v().inInbox ? "Archive" : "To inbox",
                run: async () => {
                  const archive = v().inInbox;
                  const ok = await act(archive ? "mail.archive" : "mail.unarchive", {
                    ids: [v().id],
                  });
                  if (ok && archive) pane.close?.();
                },
              },
              {
                label: v().starred ? "Unstar" : "Star",
                on: v().starred,
                run: () => void run("mail.star", { ids: [v().id], starred: !v().starred }),
              },
              { label: "Reply", run: () => reply(false) },
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
