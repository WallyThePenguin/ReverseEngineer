// Markdown checklists in notes: "- [ ] call the plumber". Unchecked items can become tasks,
// and the line then links to its task.
import { parseMentions, renderMention } from "@hearth/core";

export interface ChecklistItem {
  /** 0-based line number in the body. */
  line: number;
  text: string;
  checked: boolean;
  linkedTaskId: string | null;
}

const ITEM = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/;

export function parseChecklist(body: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  body.split("\n").forEach((raw, line) => {
    const m = ITEM.exec(raw);
    if (!m) return;
    const text = m[4] ?? "";
    const task = parseMentions(text).find((x) => x.type === "task");
    items.push({ line, text, checked: m[2] !== " ", linkedTaskId: task?.id ?? null });
  });
  return items;
}

/** Open items that aren't linked to a task yet. */
export function openUnlinkedItems(body: string): ChecklistItem[] {
  return parseChecklist(body).filter(
    (i) => !i.checked && !i.linkedTaskId && i.text.trim().length > 0,
  );
}

/**
 * The edit that replaces an item's text with a mention of the task it became: where it starts,
 * how much it replaces, and what goes there. Only that item's own text changes (D59), so typing
 * anywhere else in the note is untouched. Null when the line isn't an item.
 */
export function itemLink(
  body: string,
  line: number,
  task: { id: string; label: string },
): { at: number; length: number; insert: string } | null {
  const lines = body.split("\n");
  const raw = lines[line];
  const m = raw === undefined ? null : ITEM.exec(raw);
  if (!m) return null;
  let at = m[1]!.length + m[2]!.length + m[3]!.length;
  for (let n = 0; n < line; n++) at += lines[n]!.length + 1;
  const insert = renderMention({ type: "task", id: task.id, label: task.label });
  return { at, length: m[4]!.length, insert };
}

/** Replaces an item's text with a mention of the task it became. */
export function linkItemToTask(
  body: string,
  line: number,
  task: { id: string; label: string },
): string {
  const edit = itemLink(body, line, task);
  if (!edit) return body;
  return body.slice(0, edit.at) + edit.insert + body.slice(edit.at + edit.length);
}
