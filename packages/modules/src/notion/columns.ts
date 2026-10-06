// Which of a Notion database's columns say who a ticket is for, whether it's done and when it's
// due, picked from their names and kinds, so any task board works without setup. Otopair's board:
// Assignee, Status (its Complete group is done) and End date.
import type { NotionColumns } from "@hearth/db";
import type { NotionPage, NotionSchema } from "./api.ts";

/**
 * - assignee null: nobody is named on the board, so every ticket is yours (a personal list).
 * - status: a status or select column, with its options that mean done; or doneBox, a checkbox.
 */
export type Columns = NotionColumns;

const named = (cols: { name: string; type: string }[], type: string, ...words: RegExp[]) => {
  const of = cols.filter((c) => c.type === type);
  for (const w of words) {
    const hit = of.find((c) => w.test(c.name));
    if (hit) return hit.name;
  }
  return of.length === 1 ? of[0]!.name : null;
};

export function pickColumns(s: NotionSchema): Columns {
  const cols = s.columns;
  const title = cols.find((c) => c.type === "title")?.name ?? "Name";
  const assignee = named(cols, "people", /assign/i, /owner|responsible|who/i);
  const statusCol = cols.find((c) => c.type === "status")?.name ?? null;
  const selectCol = statusCol ? null : named(cols, "select", /status|state|stage/i);
  const status = statusCol ?? selectCol;
  const doneOptions = statusCol
    ? (s.complete[statusCol] ?? [])
    : selectCol
      ? ["Done", "Complete", "Completed", "Closed", "Canceled", "Cancelled"]
      : [];
  const doneBox = status ? null : named(cols, "checkbox", /done|complete|finished/i);
  const due = named(cols, "date", /due|deadline/i, /end|finish/i);
  return { title, assignee, status, doneOptions, doneBox, due };
}

export interface Ticket {
  title: string;
  assignees: string[];
  status: string | null;
  done: boolean;
  /** "2026-10-10" for a day, or a full ISO time when the column has one. */
  dueAt: string | null;
  dueIsDate: boolean;
}

export function ticketOf(p: NotionPage, c: Columns): Ticket {
  const v = p.values;
  const t = v[c.title];
  const who = c.assignee ? v[c.assignee] : undefined;
  const st = c.status ? v[c.status] : undefined;
  const box = c.doneBox ? v[c.doneBox] : undefined;
  const d = c.due ? v[c.due] : undefined;
  const status = st && (st.type === "status" || st.type === "select") ? st.name : null;
  const done =
    box?.type === "checkbox"
      ? box.checked
      : status !== null && c.doneOptions.some((o) => o.toLowerCase() === status.toLowerCase());
  // A range is due when it ends.
  const due = d?.type === "date" ? (d.end ?? d.start) : null;
  return {
    title: t?.type === "title" ? t.text.trim() : "",
    assignees: who?.type === "people" ? who.ids : [],
    status,
    done,
    dueAt: due ? (due.length === 10 ? due : new Date(due).toISOString()) : null,
    dueIsDate: due !== null && due.length === 10,
  };
}
