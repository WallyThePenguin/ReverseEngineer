// Answering an invitation, wherever one shows (an email, a row of your calendar, Today): Going,
// Maybe or Not going, the answer you gave already marked. A repeating meeting asks whether the
// answer is for every time or this time only.

import { createSignal, For, Show } from "solid-js";
import { toast } from "../lib/live.ts";
import { act } from "../lib/query.ts";
import { Button } from "./kit/Button.tsx";

export const ANSWERS = [
  { response: "accepted", label: "Going" },
  { response: "tentative", label: "Maybe" },
  { response: "declined", label: "Not going" },
] as const;

/** Sends your answer; the organizer sees it. A repeating meeting's needs `scope`. */
export async function answer(
  eventId: string,
  response: (typeof ANSWERS)[number]["response"],
  scope?: "all" | "this",
): Promise<boolean> {
  const done = await act("calendar.respond", {
    id: eventId,
    response,
    ...(scope ? { scope } : {}),
  });
  if (done) toast.show("Answered. The organizer will see it.");
  return done !== null;
}

export function InviteAnswers(props: {
  eventId: string;
  /** The answer you gave already, if any: its button shows as chosen. */
  response: string | null;
  /** One time of a repeating meeting. */
  recurring: boolean;
  /** Placement only (a margin, a width). */
  class?: string;
}) {
  // A repeating meeting is answered for every time, unless you say this time only.
  const [scope, setScope] = createSignal<"all" | "this">("all");
  const [busy, setBusy] = createSignal(false);
  const send = async (response: (typeof ANSWERS)[number]["response"]) => {
    setBusy(true);
    try {
      await answer(props.eventId, response, props.recurring ? scope() : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset
      aria-label="Your answer"
      class={`flex flex-wrap items-center gap-2 ${props.class ?? ""}`}
      // A row it sits in opens the event; answering doesn't.
      onClick={(e) => e.stopPropagation()}
    >
      <Show when={props.recurring}>
        <select
          class="min-h-11 rounded-md border border-line bg-panel px-2 py-1 text-xs md:min-h-0"
          aria-label="Which times"
          value={scope()}
          onChange={(x) => setScope(x.currentTarget.value as "all" | "this")}
        >
          <option value="all">Every time</option>
          <option value="this">This time only</option>
        </select>
      </Show>
      <For each={ANSWERS}>
        {(a) => (
          <Button
            small
            kind={props.response === a.response ? "primary" : undefined}
            disabled={busy()}
            onClick={() => void send(a.response)}
          >
            {a.label}
          </Button>
        )}
      </For>
    </fieldset>
  );
}
