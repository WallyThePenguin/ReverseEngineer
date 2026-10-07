import { describe, expect, it } from "vitest";
import type { Notification, NotificationUndo } from "./types.ts";
import { undoLabel } from "./undo.ts";

const row = (undo: NotificationUndo | null, entityTitle: string | null = "Dentist") => ({
  notification: { undo } as Notification,
  entityTitle,
});
const id = "00000000-0000-4000-8000-000000000000";

describe("the Undo on Jarvis's note", () => {
  it("says exactly what it puts back", () => {
    expect(undoLabel(row({ kind: "unaccept", eventId: id, before: { scope: "this" } }))).toBe(
      "Undo: take back the yes to Dentist",
    );
    expect(undoLabel(row({ kind: "unaccept", eventId: id, before: { scope: "all" } }))).toBe(
      "Undo: take back the yes to every Dentist",
    );
    const when = "Mon 2026-10-12, 10 a.m.";
    expect(
      undoLabel(row({ kind: "unmove", eventId: id, before: { start: "", end: "", when } })),
    ).toBe("Undo: move Dentist back to Mon 2026-10-12, 10 a.m.");
    expect(
      undoLabel(row({ kind: "unremove", eventId: id, before: { title: "Dentist", when } })),
    ).toBe("Undo: put Dentist back on Mon 2026-10-12, 10 a.m.");
  });

  it("isn't there when there's nothing to undo, or a kind it doesn't know", () => {
    expect(undoLabel(row(null))).toBeNull();
    expect(undoLabel(row({ kind: "run_anything" } as unknown as NotificationUndo))).toBeNull();
  });
});
