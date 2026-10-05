// Where the markdown in one line of a note is, so the editor can show it as what it means
// (headings big, **bold** bold, `code` in mono) while the marks stay there to edit.

export interface LineMarks {
  /** A class for the whole line: a heading or a quote. */
  line?: string;
  /** Spans inside the line, as [from, to, class], in order. */
  marks: [number, number, string][];
}

const LINES: [RegExp, string][] = [
  [/^# /, "cm-md-h1"],
  [/^## /, "cm-md-h2"],
  [/^#{3,6} /, "cm-md-h3"],
  [/^> /, "cm-md-quote"],
];

const SPANS: [RegExp, string][] = [
  [/\*\*[^*\n]+\*\*/g, "cm-md-strong"],
  [/(?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*])/g, "cm-md-em"],
  [/(?<![\w_])_[^_\s][^_\n]*?_(?![\w_])/g, "cm-md-em"],
  [/`[^`\n]+`/g, "cm-md-code"],
  [/~~[^~\n]+~~/g, "cm-md-strike"],
  // A list's marker or a heading's hashes, without the indent before them.
  [/^(\s*)(?:[-*+]|\d{1,4}[.)])(?= )/g, "cm-md-marker"],
  [/^()#{1,6}(?= )/g, "cm-md-marker"],
];

/** The marks in one line of markdown. Mention chips (<m-ref …>) are left alone. */
export function lineMarks(text: string): LineMarks {
  const marks: [number, number, string][] = [];
  for (const [re, cls] of SPANS)
    for (const m of text.matchAll(re)) {
      const from = m.index + (m[1]?.length ?? 0);
      const to = m.index + m[0].length;
      if (to > from && !insideChip(text, from)) marks.push([from, to, cls]);
    }
  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const line = LINES.find(([re]) => re.test(text))?.[1];
  return line ? { line, marks } : { marks };
}

/** Whether a position is inside a mention (<m-ref …>label</m-ref>), which the editor draws as a chip. */
function insideChip(text: string, at: number): boolean {
  const open = text.lastIndexOf("<m-ref", at);
  if (open === -1) return false;
  const close = text.indexOf("</m-ref>", open);
  return close === -1 || at < close + "</m-ref>".length;
}
