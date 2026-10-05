// How the note editor looks: markdown shown as what it means while the marks stay editable
// (lib/mdmarks.ts finds them), and the @ popup drawn in Hearth's colors for light and dark.

import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { lineMarks } from "../lib/mdmarks.ts";

const lines = new Map<string, Decoration>();
const marks = new Map<string, Decoration>();
const lineDeco = (cls: string) =>
  lines.get(cls) ?? lines.set(cls, Decoration.line({ class: cls })).get(cls)!;
const markDeco = (cls: string) =>
  marks.get(cls) ?? marks.set(cls, Decoration.mark({ class: cls })).get(cls)!;

/** Decorations for the lines on screen, so a long note costs only what's showing. */
function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let next = 0;
  for (const { from, to } of view.visibleRanges) {
    // Two visible ranges can share a line; each line is decorated once.
    let pos = Math.max(from, next);
    while (pos <= to) {
      const l = view.state.doc.lineAt(pos);
      const found = lineMarks(l.text);
      if (found.line) builder.add(l.from, l.from, lineDeco(found.line));
      for (const [a, b, cls] of found.marks) builder.add(l.from + a, l.from + b, markDeco(cls));
      pos = next = l.to + 1;
    }
  }
  return builder.finish();
}

const highlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = decorate(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const look = EditorView.theme({
  ".cm-md-h1": { fontSize: "1.5em", fontWeight: "700" },
  ".cm-md-h2": { fontSize: "1.25em", fontWeight: "650" },
  ".cm-md-h3": { fontSize: "1.1em", fontWeight: "600" },
  ".cm-md-quote": {
    color: "var(--color-muted)",
    borderLeft: "2px solid var(--color-line)",
    paddingLeft: "8px",
  },
  ".cm-md-strong": { fontWeight: "650" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through", color: "var(--color-muted)" },
  ".cm-md-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    backgroundColor: "var(--color-sunk)",
    borderRadius: "3px",
  },
  ".cm-md-marker": { color: "var(--color-faint)" },
  // The @ popup, in Hearth's colors rather than CodeMirror's light grey.
  ".cm-tooltip": {
    backgroundColor: "var(--color-panel)",
    color: "var(--color-ink)",
    border: "1px solid var(--color-line)",
    borderRadius: "8px",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.18)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
    maxHeight: "16rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "4px 10px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--color-accent-soft)",
    color: "var(--color-ink)",
  },
  ".cm-completionDetail": { color: "var(--color-muted)", fontStyle: "normal", marginLeft: "8px" },
});

/** Everything above, as one extension for the editor. */
export const editorLook: Extension = [highlight, look];
