// Naming a conversation: a box in place of its title. Enter or leaving it saves, Escape doesn't.

import { onMount } from "solid-js";
import { act } from "../lib/query.ts";

/** Renames a conversation. Returns false when it didn't go through (the error shows). */
export async function renameConversation(id: string, title: string): Promise<boolean> {
  return (await act("conversation.rename", { id, title })) !== null;
}

export function RenameInput(props: {
  value: string;
  /** The new name, or null when it was left as it was. */
  onDone: (title: string | null) => void;
  class?: string;
}) {
  let el!: HTMLInputElement;
  let cancelled = false;
  onMount(() => {
    el.focus();
    el.select();
  });
  return (
    <input
      ref={el}
      class={props.class ?? "min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-sm"}
      aria-label="Conversation name"
      value={props.value}
      maxLength={200}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        const title = e.currentTarget.value.trim();
        props.onDone(cancelled || !title || title === props.value ? null : title);
      }}
    />
  );
}
