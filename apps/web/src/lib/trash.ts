// Moving records to the trash and back. Every move says what went, with an Undo right there.

import { sendKeptNotes } from "./docStore.ts";
import type { Binding } from "./hotkeys.ts";
import { onLiveEvent, toast } from "./live.ts";
import { act } from "./query.ts";

/** What you can move to the trash yourself; mail and events belong to their sync. */
export const TRASHABLE = new Set([
  "note",
  "task",
  "canvas",
  "spreadsheet",
  "person",
  "company",
  "conversation",
  "meeting",
  "page_watch",
  "memory_note",
  "snippet",
  "comment",
  "brief",
  "journal",
]);

/** Restores this close together (a record and what went with it, an event each) send once. */
const SEND_KEPT_AFTER_MS = 300;

interface Moved {
  title: string;
  /** Records under it that moved with it. */
  withIt: number;
}

/** "Plan the move" in quotes, short enough for a toast; "it" when it has no title. */
export function named(title: string): string {
  const t = title.trim();
  if (!t) return "it";
  return `"${t.length > 48 ? `${t.slice(0, 47)}…` : t}"`;
}

function more(n: number): string {
  return n ? ` and ${n} record${n === 1 ? "" : "s"} under it` : "";
}

/** Moves a record to the trash. Returns false when it didn't go (the error shows as a toast). */
export async function moveToTrash(id: string): Promise<boolean> {
  const r = await act<Moved>("entity.trash", { id });
  if (!r) return false;
  toast.show(`Moved ${named(r.title)}${more(r.withIt)} to the trash.`, "info", {
    label: "Undo",
    run: () => void restore(id),
  });
  return true;
}

/** # moves the row you're on to the trash, as it does in Mail. */
export function trashKey(current: () => { id: string } | undefined, when: () => boolean): Binding {
  return {
    keys: "#",
    label: "Move to trash",
    when,
    run: () => {
      const row = current();
      if (row) void moveToTrash(row.id);
    },
  };
}

/** Brings a record back, with what went to the trash with it. */
export async function restore(id: string): Promise<boolean> {
  const r = await act<Moved>("entity.restore", { id });
  if (!r) return false;
  toast.show(`Restored ${named(r.title)}${more(r.withIt)}.`);
  return true;
}

/**
 * Whenever something comes back from the trash, restored here or anywhere else (Jarvis, the
 * phone, another browser), sends the edits this device kept for notes deleted before they reached
 * Hearth. An open note sends its own; one that isn't open would otherwise wait for the next start
 * of Hearth here (D59). One send at a time, so two never open the same note at once.
 */
export function sendKeptOnRestore(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = Promise.resolve();
  const stop = onLiveEvent((e) => {
    if (e.kind !== "entity.restored") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      sending = sending.then(sendKeptNotes).catch(() => {});
    }, SEND_KEPT_AFTER_MS);
  });
  return () => {
    clearTimeout(timer);
    stop();
  };
}
