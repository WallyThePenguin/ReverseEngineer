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

/** Replaces an item's text with a mention of the task it became. */
export function linkItemToTask(
  body: string,
  line: number,
  task: { id: string; label: string },
): string {
  const lines = body.split("\n");
  const raw = lines[line];
  const m = raw === undefined ? null : ITEM.exec(raw);
  if (!m) return body;
  lines[line] =
    `${m[1]}${m[2]}${m[3]}${renderMention({ type: "task", id: task.id, label: task.label })}`;
  return lines.join("\n");
}
