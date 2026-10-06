// What a conversation with Jarvis shows, one row at a time: a message from you or from Jarvis, a
// tool Jarvis used, a notice (with Retry when a turn failed), Jarvis's reply as it streams in, and
// the suggestions a new conversation starts with.

import type { ConversationItem } from "@hearth/core";
import { For, Match, Show, Switch } from "solid-js";
import { Body } from "../components/Body.tsx";
import { JarvisMark } from "../components/Mark.tsx";
import { act } from "../lib/query.ts";
import { ToolLine } from "./ToolLine.tsx";

/** Something Jarvis said, or is saying as it streams in (its mark pulses while it does). */
export function JarvisSays(props: { text: string; streaming?: boolean }) {
  return (
    <div class="mr-2">
      <p class="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-jarvis">
        <JarvisMark size={12} state={props.streaming ? "thinking" : "idle"} />
        Jarvis
      </p>
      <Body text={props.text} />
    </div>
  );
}

/** One row of the conversation's log. */
export function LogItem(props: { item: ConversationItem }) {
  return (
    <Switch>
      <Match when={props.item.type === "message" && props.item}>
        {(m) => (
          <Show when={m().role === "you"} fallback={<JarvisSays text={m().text} />}>
            <div class="ml-8 rounded-lg bg-sunk px-3 py-2">
              {/* Someone in Slack wrote it, or you did, in your DM with Jarvis (D62). */}
              <Show when={m().author ?? (m().via === "slack" ? "You, in Slack" : null)}>
                {(who) => <p class="mb-0.5 text-xs font-medium text-muted">{who()}</p>}
              </Show>
              <Body text={m().text} />
            </div>
          </Show>
        )}
      </Match>
      <Match when={props.item.type === "tool" && props.item}>
        {(t) => <ToolLine item={t()} />}
      </Match>
      <Match when={props.item.type === "notice" && props.item}>
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
  );
}

const STARTERS = [
  "What's on my plate today?",
  "What did you do for me since yesterday?",
  "Make me a task to call the dentist tomorrow at 10 a.m.",
  "Watch for any task due this week that I haven't started, and tell me.",
];

/** A new conversation's first words: things to ask, or with a record open, things to ask about it. */
export function Starter(props: {
  onPick: (text: string) => void;
  /** Asks that fit the record you have open (lib/looking.ts). */
  about?: readonly string[] | null;
}) {
  return (
    <div class="space-y-3 py-6">
      <p class="text-muted">
        Ask for anything in Hearth. Jarvis can read and change your tasks, notes and people, search
        the web, and set up watches. Anything other people would see waits for your yes.
      </p>
      <div class="space-y-1">
        <For each={props.about ?? STARTERS}>
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
