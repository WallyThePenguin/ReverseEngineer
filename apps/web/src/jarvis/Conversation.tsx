// A conversation with Jarvis: messages, the tools it used, approvals it's waiting on, and the
// reply streaming in as it's written. Live and reloaded views come from the same fold.

import { type ConversationItem, foldConversation, fromEditForm } from "@hearth/core";
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { Body } from "../components/Body.tsx";
import { MentionEditor } from "../components/MentionEditor.tsx";
import { Button, PaneHeader } from "../components/ui.tsx";
import { decide, deciding, isDecided } from "../lib/approvals.ts";
import { live } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import { hush, mic, say, talkTaken, talkWanted } from "../lib/speech.ts";
import type { LogRecord } from "../lib/types.ts";

/** How long what you sent may wait for Jarvis to start before it says so. */
const SLOW_MS = 20_000;

interface ConversationData {
  conversation: { id: string; title: string };
  log: LogRecord[];
}

function ToolLine(props: { item: Extract<ConversationItem, { type: "tool" }> }) {
  const [open, setOpen] = createSignal(false);
  const name = () => props.item.name.replace(/^mcp__hearth__/, "").replaceAll("_", " ");
  return (
    <div class="text-xs text-muted">
      <button type="button" class="hover:text-ink" onClick={() => setOpen(!open())}>
        {props.item.status === "running" ? "Using" : "Used"} {name()}
        {props.item.isError ? " (failed)" : ""}
      </button>
      <Show
        when={
          props.item.status === "pending_approval" &&
          props.item.approvalId &&
          !isDecided(props.item.approvalId)
        }
      >
        <div class="mt-1 flex items-center gap-2 rounded-md bg-accent-soft px-2 py-1.5 text-ink">
          <span class="flex-1 whitespace-pre-wrap">
            Waiting for your yes: {props.item.output || "see the Inbox."}
          </span>
          <Button
            kind="primary"
            small
            disabled={deciding(props.item.approvalId!)}
            onClick={() => decide(props.item.approvalId!, "approve")}
          >
            Approve
          </Button>
          <Button
            kind="danger"
            small
            disabled={deciding(props.item.approvalId!)}
            onClick={() => decide(props.item.approvalId!, "deny")}
          >
            Deny
          </Button>
        </div>
      </Show>
      <Show when={open()}>
        <pre class="mt-1 max-h-48 overflow-auto rounded bg-sunk p-2 font-mono text-[11px] whitespace-pre-wrap">
          {JSON.stringify(props.item.input, null, 2)}
          {props.item.output ? `\n→ ${props.item.output}` : ""}
        </pre>
      </Show>
    </div>
  );
}

export function Conversation(props: {
  id: string | null;
  onCreated?: (id: string) => void;
  compact?: boolean;
}) {
  const data = useAction<ConversationData>(
    "conversation.get",
    () => ({ id: props.id }),
    () => !!props.id,
  );
  const view = () => foldConversation(data.data?.log ?? []);
  const streaming = () =>
    Object.entries(live.streams())
      .filter(([turnId, s]) => s.conversationId === props.id && view().activeTurns.includes(turnId))
      .map(([, s]) => s.text);
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

  createEffect(
    on([() => view().items.length, () => streaming().join("").length], () =>
      queueMicrotask(() => scroller?.scrollTo({ top: scroller.scrollHeight })),
    ),
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
    const r = await act<{ conversationId: string }>("chat.send", {
      text,
      ...(spoken ? { heard: true } : {}),
      ...(props.id ? { conversationId: props.id } : {}),
    });
    setSending(false);
    if (!r) return false;
    setDraft("");
    if (!props.id) props.onCreated?.(r.conversationId);
    return true;
  };

  return (
    <div class="flex h-full flex-col">
      <div ref={scroller} class="flex-1 space-y-3 overflow-auto px-4 py-3">
        <Show when={props.id} fallback={<Starter onPick={(t) => setDraft(t)} />}>
          <For each={view().items}>
            {(item) => (
              <Switch>
                <Match when={item.type === "message" && item}>
                  {(m) => (
                    <div class={m().role === "you" ? "ml-8 rounded-lg bg-sunk px-3 py-2" : "mr-2"}>
                      <Show when={m().role === "jarvis"}>
                        <p class="mb-0.5 text-xs font-medium text-jarvis">Jarvis</p>
                      </Show>
                      <Body text={m().text} />
                    </div>
                  )}
                </Match>
                <Match when={item.type === "tool" && item}>{(t) => <ToolLine item={t()} />}</Match>
                <Match when={item.type === "notice" && item}>
                  {(n) => (
                    <p class={`text-xs ${n().tone === "error" ? "text-bad" : "text-muted"}`}>
                      {n().text}
                      <Show when={n().retry && n().turnId}>
                        {(turnId) => (
                          <>
                            {" "}
                            <button
                              type="button"
                              class="font-medium underline hover:text-ink"
                              onClick={() => void act("jarvis.retry_turn", { turnId: turnId() })}
                            >
                              Retry
                            </button>
                          </>
                        )}
                      </Show>
                    </p>
                  )}
                </Match>
              </Switch>
            )}
          </For>
          <For each={streaming()}>
            {(text) => (
              <div class="mr-2">
                <p class="mb-0.5 text-xs font-medium text-jarvis">Jarvis</p>
                <Body text={text} />
              </div>
            )}
          </For>
          <Show when={busy()}>
            <div class="flex items-center gap-2 text-sm text-jarvis">
              <Show when={streaming().length === 0}>
                <span class="inline-block size-2 animate-pulse rounded-full bg-jarvis" /> Thinking…
              </Show>
              <span class="flex-1" />
              <Button small disabled={stopping()} title="Stop Jarvis" onClick={() => void stop()}>
                {stopping() ? "Stopping…" : "Stop"}
              </Button>
            </div>
          </Show>
          <Show when={slow()}>
            <p class="text-xs text-muted">
              Jarvis hasn't started on this yet. It may still be busy, or not running. Stop lets it
              go.
            </p>
          </Show>
        </Show>
      </div>
      <div class="border-t border-line p-3">
        <MentionEditor
          value={draft()}
          onInput={setDraft}
          onSubmit={() => void send()}
          rows={props.compact ? 2 : 3}
          autofocus={!props.compact}
          placeholder="Ask Jarvis anything, or @ a task or note (Ctrl+Enter to send)"
        />
        <div class="mt-2 flex justify-end gap-2">
          <Button
            small
            kind={mic.state() === "listening" ? "danger" : "plain"}
            disabled={mic.state() === "working"}
            title="Talk to Jarvis: tap, speak, tap again. The answer is read aloud."
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

const STARTERS = [
  "What's on my plate today?",
  "What did you do for me since yesterday?",
  "Make me a task to call the dentist tomorrow at 10 a.m.",
  "Watch for any task due this week that I haven't started, and tell me.",
];

function Starter(props: { onPick: (text: string) => void }) {
  return (
    <div class="space-y-3 py-6">
      <p class="text-muted">
        Ask for anything in Hearth. Jarvis can read and change your tasks, notes and people, search
        the web, and set up watches. Anything other people would see waits for your yes.
      </p>
      <div class="space-y-1">
        <For each={STARTERS}>
          {(s) => (
            <button
              type="button"
              class="block w-full rounded-md border border-line px-3 py-2 text-left text-sm hover:bg-sunk"
              onClick={() => props.onPick(s)}
            >
              {s}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/** A conversation opened in its own pane. */
export function ChatView(props: { id: string }) {
  const data = useAction<ConversationData>("conversation.get", () => ({ id: props.id }));
  return (
    <div class="flex h-full flex-col">
      <PaneHeader title={data.data?.conversation.title || "Conversation"} sub="With Jarvis" />
      <div class="min-h-0 flex-1">
        <Conversation id={props.id} />
      </div>
    </div>
  );
}
