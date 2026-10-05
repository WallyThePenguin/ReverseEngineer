// Your notes during a meeting: saved a moment after you stop typing, kept on this device until
// Hearth has them, and sent as the page closes, so a crash or a closed laptop mid-meeting loses
// nothing (D59). Notes saved elsewhere meanwhile are merged line by line, not overwritten, and so
// is what's typed before Hearth's notes are first read.

import { mergeText } from "@hearth/core";
import { createEffect, on, onCleanup, onMount, Show } from "solid-js";
import { action } from "../lib/api.ts";
import { createSaver } from "../lib/wholeSave.ts";

export function MeetingNotes(props: { id: string; notes: string; revision: number }) {
  let area: HTMLTextAreaElement | undefined;
  const saver = createSaver<string>({
    id: props.id,
    key: `meeting:${props.id}`,
    noun: "meeting",
    action: "meeting.update",
    input: (notes, revision) => ({ id: props.id, notes, revision }),
    savedAs: (r) => (r as { revision: number }).revision,
    async get() {
      const r = await action<{ title: string; notes: string; revision: number }>("meeting.get", {
        id: props.id,
      });
      return { title: r.title, data: r.notes, version: r.revision };
    },
    merge: mergeText,
    empty: () => "",
    // Typed before the first read, onto the page's copy (on flaky Wi-Fi, say): merged onto none,
    // so Hearth's lines all stay.
    beforeRead: true,
    current: () => area?.value ?? "",
    show(notes) {
      if (!area || area.value === notes) return;
      // Keep the caret where it was when a merge adds lines below it.
      const [start, end] = [area.selectionStart, area.selectionEnd];
      area.value = notes;
      if (document.activeElement === area) area.setSelectionRange(start, end);
    },
  });

  onMount(() => void saver.load());
  // A newer copy from elsewhere: the page reads the meeting again every few seconds while it's on.
  createEffect(
    on(
      () => props.revision,
      () => void saver.load(),
      { defer: true },
    ),
  );
  onCleanup(() => void saver.close());

  return (
    <div>
      <textarea
        ref={(el) => {
          area = el;
          // Set once: after this, what's typed here is the copy on screen, not the page's data.
          el.value = props.notes;
        }}
        class="min-h-32 w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none"
        placeholder="What matters in this meeting…"
        onInput={() => saver.changed()}
      />
      <Show when={saver.problem()}>{(why) => <p class="mt-1 text-xs text-bad">{why()}</p>}</Show>
    </div>
  );
}
