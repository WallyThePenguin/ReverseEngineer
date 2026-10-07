// The Undo on Jarvis's note about something it did to your calendar on its own (D71, D72). Its
// words say exactly what pressing it does, from the same closed shape the server maps to one
// change.

import type { InboxRow } from "./types.ts";

/** "Undo: move Dentist back to Mon 2026-10-12, 10 a.m.", or null when there's nothing to undo. */
export function undoLabel(row: Pick<InboxRow, "notification" | "entityTitle">): string | null {
  const u = row.notification.undo;
  if (!u) return null;
  const title = row.entityTitle ?? "the event";
  switch (u.kind) {
    case "unaccept":
      return `Undo: take back the yes to ${u.before.scope === "all" ? "every " : ""}${title}`;
    case "unmove":
      return `Undo: move ${title} back to ${u.before.when}`;
    case "unremove":
      return `Undo: put ${u.before.title} back on ${u.before.when}`;
    default:
      return null;
  }
}
