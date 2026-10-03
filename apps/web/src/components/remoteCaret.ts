// Where someone else just edited the doc you have open (Jarvis, or you on another screen): a
// labelled caret at the end of their latest change, for a few seconds (PLAN.md section 8.5).

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

const SHOW_MS = 4000;
const setCaret = StateEffect.define<{ pos: number; label: string } | null>();

class Caret extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(o: Caret) {
    return o.label === this.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "remote-caret";
    el.setAttribute("aria-label", `${this.label} is editing here`);
    const tag = document.createElement("span");
    tag.textContent = this.label;
    el.append(tag);
    return el;
  }
}

const caretField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setCaret))
        next = e.value
          ? Decoration.set([
              Decoration.widget({ widget: new Caret(e.value.label), side: 1 }).range(
                Math.min(e.value.pos, tr.state.doc.length),
              ),
            ])
          : Decoration.none;
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.baseTheme({
  ".remote-caret": {
    position: "relative",
    borderLeft: "2px solid var(--color-jarvis)",
    marginLeft: "-1px",
  },
  ".remote-caret > span": {
    position: "absolute",
    top: "-1.3em",
    left: "-2px",
    padding: "0 4px",
    borderRadius: "3px",
    fontSize: "11px",
    lineHeight: "1.4",
    whiteSpace: "nowrap",
    color: "white",
    backgroundColor: "var(--color-jarvis)",
    pointerEvents: "none",
  },
});

/** Shows a caret named by `who()` after each change that came from elsewhere. */
export function remoteCaret(who: () => string | null) {
  let timer: number | undefined;
  const listener = EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const label = who();
    const remote = u.transactions.some(
      (tr) =>
        tr.docChanged &&
        !["input", "delete", "undo", "redo", "move", "select"].some((t) => tr.isUserEvent(t)),
    );
    if (!remote || !label) return;
    let pos = -1;
    u.changes.iterChangedRanges((_fa, _ta, _fb, toB) => {
      pos = Math.max(pos, toB);
    });
    if (pos < 0) return;
    queueMicrotask(() => u.view.dispatch({ effects: setCaret.of({ pos, label }) }));
    window.clearTimeout(timer);
    timer = window.setTimeout(() => u.view.dispatch({ effects: setCaret.of(null) }), SHOW_MS);
  });
  return [caretField, theme, listener];
}
