// The live editor for a note: CodeMirror on a Loro doc, so what you type merges with your other
// screens and with Jarvis's edits as they happen. @ links anything; links show as chips and
// checklist boxes can be ticked in place.

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { JARVIS_ENTITY_ID, newMentionId, renderMention, unescapeText } from "@hearth/core";
import { LoroExtensions } from "loro-codemirror";
import { UndoManager } from "loro-crdt";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { action } from "../lib/api.ts";
import { type DocStatus, LiveDoc } from "../lib/doc.ts";
import { TYPE_LABEL, who } from "../lib/format.ts";
import { layout, routeFor } from "../lib/panes.ts";
import type { SearchHit } from "../lib/types.ts";
import { remoteCaret } from "./remoteCaret.ts";

const TAG = /<m-ref\s+([^>]*)>([\s\S]*?)<\/m-ref>/g;
const attr = (attrs: string, name: string) =>
  new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";

class MentionChip extends WidgetType {
  constructor(
    readonly type: string,
    readonly id: string,
    readonly label: string,
  ) {
    super();
  }
  eq(o: MentionChip) {
    return o.id === this.id && o.label === this.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cursor-pointer rounded bg-jarvis-soft px-1 text-jarvis";
    el.textContent = `@${this.label}`;
    el.title = `${TYPE_LABEL[this.type] ?? this.type}: open it`;
    el.onmousedown = (e) => {
      e.preventDefault();
      layout.open(routeFor(this.type, this.id), { beside: e.shiftKey });
    };
    return el;
  }
}

class Checkbox extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: Checkbox) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "mx-0.5 align-middle";
    box.onmousedown = (e) => {
      e.preventDefault();
      const at = view.posAtDOM(box);
      view.dispatch({ changes: { from: at + 1, to: at + 2, insert: this.checked ? " " : "x" } });
    };
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

function decorate(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of text.matchAll(TAG)) {
      const start = from + m.index;
      const label = unescapeText(m[2]!);
      const chip = new MentionChip(attr(m[1]!, "type"), attr(m[1]!, "id"), label);
      out.push(Decoration.replace({ widget: chip }).range(start, start + m[0].length));
    }
    for (const m of text.matchAll(/^(\s*[-*] )\[( |x|X)\](?= )/gm)) {
      const start = from + m.index + m[1]!.length;
      const box = new Checkbox(m[2] !== " ");
      out.push(Decoration.replace({ widget: box }).range(start, start + 3));
    }
  }
  return Decoration.set(out, true);
}

const chips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = decorate(u.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (p) =>
      EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none),
  },
);

const JARVIS: SearchHit = { id: JARVIS_ENTITY_ID, type: "agent", title: "Jarvis", updatedAt: "" };

async function mentions(ctx: CompletionContext) {
  const word = ctx.matchBefore(/(^|\s)@[^@<>\n]{0,40}$/);
  if (!word) return null;
  const at = word.text.indexOf("@");
  const query = word.text.slice(at + 1);
  const found = query
    ? await action<SearchHit[]>("entity.search", { query, limit: 8 }).catch(() => [])
    : await action<SearchHit[]>("entity.recent", { limit: 8 }).catch(() => []);
  const hits = [
    ...("jarvis".startsWith(query.toLowerCase()) ? [JARVIS] : []),
    ...found.filter((h) => h.id !== JARVIS_ENTITY_ID && h.type !== "comment"),
  ];
  return {
    from: word.from + at,
    filter: false,
    options: hits.map(
      (h): Completion => ({
        label: h.title || "Untitled",
        detail: TYPE_LABEL[h.type] ?? h.type,
        // Its own id: the anchor Jarvis answers it by, however the note changes around it (D59).
        apply: renderMention({
          type: h.type,
          id: h.id,
          label: h.title || "Untitled",
          mid: newMentionId(),
        }),
      }),
    ),
  };
}

const theme = EditorView.theme({
  "&": { fontSize: "15px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { fontFamily: "var(--font-sans)", lineHeight: "1.6", minHeight: "16rem" },
  ".cm-placeholder": { color: "var(--color-faint)" },
  ".cm-cursor": { borderLeftColor: "var(--color-ink)" },
});

/** A deleted note can still be read and copied, but not changed. */
const READ_ONLY = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

export default function DocEditor(props: { id: string; placeholder?: string }) {
  let host!: HTMLDivElement;
  const [state, setState] = createSignal<"opening" | "open" | "failed">("opening");
  const [status, setStatus] = createSignal<DocStatus>({ kind: "ok" });
  const [editedBy, setEditedBy] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const editable = new Compartment();
  let view: EditorView | undefined;
  let live: LiveDoc | undefined;
  let clear: number | undefined;
  let disposed = false;

  const gone = () => {
    const s = status();
    return s.kind === "gone" ? s : null;
  };
  const refused = () => {
    const s = status();
    return s.kind === "refused" ? s.message : null;
  };
  const copy = () =>
    void navigator.clipboard
      .writeText(live?.text ?? "")
      .then(() => setCopied(true))
      .catch(() => {});

  onMount(async () => {
    const doc = new LiveDoc(props.id);
    live = doc;
    doc.onStatus = (s) => {
      setStatus(s);
      if (s.kind === "gone") view?.dispatch({ effects: editable.reconfigure(READ_ONLY) });
    };
    doc.onRemote = (actor) => {
      setEditedBy(actor);
      window.clearTimeout(clear);
      clear = window.setTimeout(() => setEditedBy(null), 5000);
    };
    try {
      await doc.open();
    } catch {
      if (!disposed) setState("failed");
      return;
    }
    // Closed while it opened: there's nowhere to show it any more.
    if (disposed) return;
    const undo = new UndoManager(doc.doc, {});
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: doc.text,
        extensions: [
          editable.of(gone() ? READ_ONLY : []),
          LoroExtensions(doc.doc, undefined, undo, (d) => d.getText("body")),
          // Undo is Loro's: it undoes only your own edits, not Jarvis's or another screen's.
          keymap.of([...completionKeymap, ...defaultKeymap]),
          markdown(),
          EditorView.lineWrapping,
          chips,
          remoteCaret(() => {
            const by = editedBy();
            return by ? who(by) : null;
          }),
          autocompletion({ override: [mentions], icons: false }),
          placeholder(props.placeholder ?? ""),
          theme,
        ],
      }),
    });
    setState("open");
  });
  onCleanup(() => {
    disposed = true;
    window.clearTimeout(clear);
    view?.destroy();
    void live?.close();
  });

  return (
    <div>
      <Show when={gone()}>
        {(g) => (
          <div class="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-line bg-sunk px-3 py-2 text-sm">
            <span>
              {g().unsent
                ? "This was deleted before your last changes reached Hearth. Copy the text to keep them."
                : "This was deleted. You can still read it here."}
            </span>
            <button type="button" class="text-accent hover:underline" onClick={copy}>
              {copied() ? "Copied" : "Copy text"}
            </button>
          </div>
        )}
      </Show>
      <div class="mb-1 flex h-5 items-center gap-3 text-xs text-faint">
        <Show when={state() === "opening"}>Opening…</Show>
        <Show when={state() === "failed"}>
          <span class="text-bad">Couldn't open this note. Check that Hearth is running.</span>
        </Show>
        <Show when={state() === "open" && status().kind === "offline"}>
          Not saved yet: can't reach Hearth. It's kept here and goes when Hearth is back.
        </Show>
        <Show when={state() === "open" && status().kind === "retrying"}>
          Not saved yet: Hearth hit a problem saving it. It's kept here, and Hearth tries again.
        </Show>
        <Show when={state() === "open" && refused()}>
          {(why) => <span class="text-bad">Hearth didn't save this: {why()}</span>}
        </Show>
        <Show when={editedBy()}>
          {(by) => <span class="text-jarvis">{who(by())} is editing…</span>}
        </Show>
      </div>
      <div ref={host} />
    </div>
  );
}
