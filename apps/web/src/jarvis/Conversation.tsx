// A conversation with Jarvis: messages, the tools it used, approvals it's waiting on, and the
// reply streaming in as it's written. Live and reloaded views come from the same fold. A Slack
// member's conversation is read-only, under a bar you act from (SlackBar.tsx, D62), wherever it
// shows, in its own pane or in Jarvis's. That's decided here, from the conversation, so no screen
// that shows one can forget it. In the Jarvis panel, the record you have open goes with what you
// ask, shown over the box (step 10); never into a member's conversation.

import { foldConversation, fromEditForm } from "@hearth/core";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { JarvisMark } from "../components/Mark.tsx";
import { MentionEditor } from "../components/MentionEditor.tsx";
import { Button, PaneHeader } from "../components/ui.tsx";
import { MOD } from "../lib/hotkeys.ts";
import { live } from "../lib/live.ts";
import { type Looking, startersFor } from "../lib/looking.ts";
import { narrow } from "../lib/narrow.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { isMemberConversation, sendsInto } from "../lib/slack.ts";
import { hush, mic, say, talkTaken, talkWanted } from "../lib/speech.ts";
import type { LogRecord } from "../lib/types.ts";
import { LookingChip, useLookingRecord } from "./LookingChip.tsx";
import { JarvisSays, LogItem, Starter } from "./Message.tsx";
import { RenameInput, renameConversation } from "./Rename.tsx";
import { SlackBar } from "./SlackBar.tsx";
import { OutsideNote } from "./ToolLine.tsx";

/** How long what you sent may wait for Jarvis to start before it says so. */
const SLOW_MS = 20_000;

interface ConversationData {
  conversation: {
    id: string;
    title: string;
    taintedAt?: string | null;
    taintSource?: string | null;
    startedVia?: string | null;
  };
  log: LogRecord[];
}

export function Conversation(props: {
  id: string | null;
  /** A conversation of yours started from here: one you wrote, or "Ask Jarvis about this". */
  onCreated?: (id: string) => void;
  /** The conversation is gone (trashed, or from before a restore). */
  onMissing?: () => void;
  compact?: boolean;
  /** What's on screen as you ask (lib/looking.ts): sent with each message, shown over the box. */
  onScreen?: { looking: () => Looking | null; takeOff: () => void };
}) {
  const data = useAction<ConversationData>(
    "conversation.get",
    () => ({ id: props.id }),
    () => !!props.id,
  );
  createEffect(() => {
    if ((data.error as { code?: string } | null)?.code === "not_found") props.onMissing?.();
  });
  // A Slack member's: only their turns write here (D62).
  const member = () => !!props.id && isMemberConversation(data.data?.conversation.startedVia);
  // Shown where you are if this place can show it, or in a pane beside it.
  const started = (id: string) =>
    props.onCreated ? props.onCreated(id) : layout.open({ view: "chat", id }, { beside: true });
  const view = () => foldConversation(data.data?.log ?? []);
  const streaming = () =>
    Object.entries(live.streams())
      .filter(([turnId, s]) => s.conversationId === props.id && view().activeTurns.includes(turnId))
      .map(([, s]) => s.text);
  // Nothing goes along into a Slack member's conversation, which only their turns write.
  const looking = () => (member() ? null : (props.onScreen?.looking() ?? null));
  const about = useLookingRecord(looking);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  let scroller!: HTMLDivElement;

  // Jarvis is working on this, or what you sent is waiting for it (D54).
  const busy = () => view().activeTurns.length > 0 || view().waitingSince !== null;
  const [now, setNow] = createSignal(Date.now());
  const tick = window.setInterval(() => setNow(Date.now()), 5000);
  onCleanup(() => window.clearInterval(tick));
  const slow = () => {
    const since = view().waitingSince;
    return since !== null && view().activeTurns.length === 0 && now() - Date.parse(since) > SLOW_MS;
  };
  // A running turn ends when the Jarvis process hears Stop, which takes a moment, or until it's
  // back if it's stuck: the button says so meanwhile rather than looking like nothing happened.
  const [stopping, setStopping] = createSignal(false);
  const stop = async () => {
    if (!props.id || stopping()) return;
    setStopping(true);
    const res = await act<{ stopping: number }>("jarvis.cancel_turn", { conversationId: props.id });
    if (!res?.stopping) setStopping(false);
  };
  createEffect(
    on(
      () => props.id,
      () => setStopping(false),
    ),
  );
  createEffect(() => {
    if (!busy()) setStopping(false);
  });

  // New words keep the bottom in view only while you're at the bottom: scrolled up to read,
  // you stay where you are, and a button takes you down.
  const [pinned, setPinned] = createSignal(true);
  const toBottom = () => {
    setPinned(true);
    queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
  };
  createEffect(on(() => props.id, toBottom));
  createEffect(
    on([() => view().items.length, () => streaming().join("").length], () => {
      if (pinned()) toBottom();
    }),
  );

  // Asked by voice: Jarvis's answers after this point are read aloud.
  const [speakFrom, setSpeakFrom] = createSignal<number | null>(null);
  createEffect(
    on(
      () => view().items.length,
      (n) => {
        const from = speakFrom();
        if (from === null || n <= from) return;
        for (const item of view().items.slice(from))
          if (item.type === "message" && item.role === "jarvis") say(item.text);
        setSpeakFrom(n);
      },
    ),
  );

  const talk = async () => {
    if (mic.state() === "listening") return mic.stop();
    hush();
    const heard = await mic.listen();
    if (!heard) return;
    setDraft(heard);
    if (await send(true)) setSpeakFrom(view().items.length);
  };

  // The phone's tab bar mic: start listening as soon as this pane is up.
  createEffect(() => {
    if (!talkWanted()) return;
    talkTaken();
    void talk();
  });

  const send = async (spoken = false) => {
    const text = fromEditForm(draft().trim());
    if (!text || sending()) return false;
    if (!spoken) setSpeakFrom(null);
    setSending(true);
    // In a member's conversation only the phone's mic gets here, and starts one of yours.
    const into = sendsInto(props.id, data.data?.conversation.startedVia);
    const r = await act<{ conversationId: string }>("chat.send", {
      text,
      ...(spoken ? { heard: true } : {}),
      ...(into ? { conversationId: into } : {}),
      ...(looking() ? { looking: looking() } : {}),
    });
    setSending(false);
    if (!r) return false;
    setDraft("");
    toBottom();
    if (!into) started(r.conversationId);
    return true;
  };

  return (
    <div class="relative flex h-full flex-col">
      <Show when={member() && props.id}>{(id) => <SlackBar id={id()} onAsked={started} />}</Show>
      <div
        ref={scroller}
        class="flex-1 space-y-3 overflow-auto px-4 py-3"
        onScroll={() =>
          setPinned(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80)
        }
      >
        <Show
          when={props.id}
          fallback={
            <Starter
              onPick={(t) => setDraft(t)}
              about={looking() ? startersFor(about.type()) : null}
            />
          }
        >
          <Show when={data.data?.conversation.taintedAt}>
            <OutsideNote source={data.data?.conversation.taintSource} />
          </Show>
          <Show when={!data.data && data.isError}>
            <p class="text-sm text-bad">
              Couldn't load this conversation.{" "}
              <button
                type="button"
                class="font-medium underline"
                onClick={() => void data.refetch()}
              >
                Try again
              </button>
            </p>
          </Show>
          <Show when={!data.data && data.isLoading}>
            <p class="text-sm text-muted">Loading…</p>
          </Show>
          <For each={view().items}>{(item) => <LogItem item={item} />}</For>
          <For each={streaming()}>{(text) => <JarvisSays text={text} streaming />}</For>
          <Show when={busy()}>
            <div class="flex items-center gap-2 text-sm text-jarvis">
              <Show when={streaming().length === 0}>
                <JarvisMark size={12} state="thinking" /> Thinking…
              </Show>
              <span class="flex-1" />
              <Button small disabled={stopping()} title="Stop Pip" onClick={() => void stop()}>
                {stopping() ? "Stopping…" : "Stop"}
              </Button>
            </div>
          </Show>
          <Show when={slow()}>
            <p class="text-xs text-muted">
              Pip hasn't started on this yet. It may still be busy, or not running. Stop lets it go.
            </p>
          </Show>
        </Show>
      </div>
      <Show when={!pinned() && props.id}>
        <div class="pointer-events-none relative">
          <button
            type="button"
            class="pointer-events-auto absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-panel px-3 py-1 text-xs font-medium shadow-pop"
            onClick={toBottom}
          >
            <Icon name="arrow-down" size={14} />
            Latest
          </button>
        </div>
      </Show>
      <Show when={member()}>
        <p class="border-t border-line px-4 py-2 text-xs text-muted">
          Only the Jarvis bot's turns for them write here. Reply as Jarvis, or ask Pip about it,
          above.
        </p>
      </Show>
      <div class={`border-t border-line p-3 ${member() ? "hidden" : ""}`}>
        {/* Drawn afresh for each record, so a switch while you talk catches the eye. */}
        <Show when={looking()?.id} keyed>
          <div class="mb-2 flex min-w-0 animate-enter">
            <LookingChip label={about.label()} onTakeOff={() => props.onScreen?.takeOff()} />
          </div>
        </Show>
        <MentionEditor
          value={draft()}
          onInput={setDraft}
          onSubmit={() => void send()}
          rows={props.compact ? 2 : 3}
          autofocus={!props.compact}
          placeholder={
            narrow()
              ? "Ask Pip anything, or @ a task or note"
              : `Ask Pip anything, or @ a task or note (${MOD}+Enter to send)`
          }
        />
        <div class="mt-2 flex justify-end gap-2">
          <Button
            small
            kind={mic.state() === "listening" ? "danger" : "plain"}
            icon={mic.state() === "listening" ? "square" : "mic"}
            disabled={mic.state() === "working"}
            title="Talk to Pip: tap, speak, tap again. The answer is read aloud."
            onClick={() => void talk()}
          >
            {mic.state() === "listening" ? "Stop" : mic.state() === "working" ? "…" : "Talk"}
          </Button>
          <Button
            kind="jarvis"
            small
            disabled={!draft().trim() || sending()}
            onClick={() => void send()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A conversation opened in its own pane. */
export function ChatView(props: { id: string }) {
  const data = useAction<ConversationData>("conversation.get", () => ({ id: props.id }));
  const [renaming, setRenaming] = createSignal(false);
  const title = () => data.data?.conversation.title || "Conversation";
  const member = () => isMemberConversation(data.data?.conversation.startedVia);
  return (
    <div class="flex h-full flex-col">
      <PaneHeader
        title={
          <Show when={renaming()} fallback={title()}>
            <RenameInput
              value={title()}
              class="w-full rounded border border-line bg-panel px-2 py-0.5 text-base font-semibold"
              onDone={(t) => {
                setRenaming(false);
                if (t) void renameConversation(props.id, t);
              }}
            />
          </Show>
        }
        sub={member() ? "The Jarvis bot and someone in your Slack" : "With Pip"}
        menu={data.data ? [{ label: "Rename", run: () => setRenaming(true) }] : []}
        record={data.data ? { id: props.id, type: "conversation" } : undefined}
      />
      <div class="min-h-0 flex-1">
        <Conversation id={props.id} />
      </div>
    </div>
  );
}
