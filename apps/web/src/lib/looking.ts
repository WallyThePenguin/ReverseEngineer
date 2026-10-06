// What you have open as you ask Jarvis (plan step 10): the record in the pane you were last in,
// sent along with what you ask (chat.send's `looking`) so "this" and "it" mean it. Hearth tells
// Jarvis its kind and id, and its title only where the words are your own (chat/screen.ts, D58).
// A screen with no record open (Today, a list) sends nothing, and nor does a conversation opened
// as a pane: it's what you're talking in, not what you're talking about.

import { createMemo, createSignal } from "solid-js";
import { layout, type PaneRoute } from "./panes.ts";

/** What chat.send is told is on screen. */
export interface Looking {
  id: string;
  view: string;
}

/** The record a pane shows, if it shows one you could be asking about. */
export function lookingAt(route: PaneRoute | undefined): Looking | null {
  if (!route || !("id" in route) || route.view === "chat") return null;
  return { id: route.id, view: route.view };
}

/** The kind of record a view shows, for its label before the record itself is read. */
export const KIND_OF_VIEW: Record<string, string> = {
  task: "task",
  note: "note",
  canvas: "canvas",
  sheet: "spreadsheet",
  thread: "email_thread",
};

/** What the Jarvis panel's box sends along: the focused pane's record, unless you took it off. */
export function useLooking(
  panes: { panes: () => readonly PaneRoute[]; focused: () => number } = layout,
) {
  const at = createMemo(() => lookingAt(panes.panes()[panes.focused()]), null, {
    equals: (a, b) => a?.id === b?.id && a?.view === b?.view,
  });
  // Taken off for this record only: opening another one brings it back.
  const [off, setOff] = createSignal<string | null>(null);
  return {
    looking: (): Looking | null => {
      const l = at();
      return l && l.id !== off() ? l : null;
    },
    takeOff: () => setOff(at()?.id ?? null),
  };
}

/** Things to ask about a record of this kind, when a new conversation starts beside it. */
export function startersFor(type: string | undefined): readonly string[] | null {
  switch (type) {
    case "email_thread":
    case "email":
      return ["Draft a reply to this", "Make tasks from this", "Find a time to meet about this"];
    case "task":
      return ["Do this for me", "Break this into steps", "When should I do this?"];
    case "meeting":
    case "event":
      return ["Prep me for this", "What should I know before this?"];
    case "note":
      return ["Summarize this", "Make tasks from this"];
    case "person":
      return ["What's going on with them?", "When did we last talk?"];
    default:
      return null;
  }
}
