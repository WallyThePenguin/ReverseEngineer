// A plain-text editor with @mentions: type @ and a name, pick a record, and it's linked.
// The text is kept in the edit form @[Label](type:id) until the rich editor lands (M4).

import { JARVIS_ENTITY_ID } from "@hearth/core";
import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { action } from "../lib/api.ts";
import { TYPE_LABEL } from "../lib/format.ts";
import { mentionQuery } from "../lib/text.ts";
import type { SearchHit } from "../lib/types.ts";

interface Props {
  value: string;
  onInput: (v: string) => void;
  /** Mod+Enter. */
  onSubmit?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  autofocus?: boolean;
  class?: string;
}

const JARVIS: SearchHit = { id: JARVIS_ENTITY_ID, type: "agent", title: "Pip", updatedAt: "" };
/** What finds Pip after an @: its name, or the one it had before (D74). */
const callsPip = (query: string) =>
  ["pip", "jarvis"].some((name) => name.startsWith(query.toLowerCase()));

export function MentionEditor(props: Props) {
  let el!: HTMLTextAreaElement;
  const [query, setQuery] = createSignal<{ start: number; query: string } | null>(null);
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [active, setActive] = createSignal(0);
  let seq = 0;

  onMount(() => {
    if (props.autofocus) el.focus();
  });

  createEffect(
    on(query, async (q) => {
      if (!q) return setHits([]);
      const mine = ++seq;
      const jarvis = callsPip(q.query) ? [JARVIS] : [];
      const found = q.query.trim()
        ? await action<SearchHit[]>("entity.search", { query: q.query, limit: 6 }).catch(() => [])
        : await action<SearchHit[]>("entity.recent", { limit: 6 }).catch(() => []);
      if (mine !== seq) return;
      setHits(
        [
          ...jarvis,
          ...found.filter((h) => h.id !== JARVIS_ENTITY_ID && h.type !== "comment"),
        ].slice(0, 7),
      );
      setActive(0);
    }),
  );

  const update = () => setQuery(mentionQuery(el.value, el.selectionStart));

  const pick = (hit: SearchHit) => {
    const q = query();
    if (!q) return;
    const label = (hit.title || "Untitled").replace(/[\]\\]/g, (c) => `\\${c}`);
    const insert = `@[${label}](${hit.type}:${hit.id}) `;
    const next = el.value.slice(0, q.start) + insert + el.value.slice(el.selectionStart);
    props.onInput(next);
    setQuery(null);
    const caret = q.start + insert.length;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const open = query() && hits().length > 0;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = hits().length;
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
      return;
    }
    if (open && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      pick(hits()[active()]!);
      return;
    }
    if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setQuery(null);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      props.onSubmit?.();
    }
  };

  return (
    <div class="relative">
      <textarea
        ref={el}
        class={`w-full resize-y rounded-md border border-line bg-panel px-3 py-2 leading-relaxed outline-none focus:border-accent ${props.class ?? ""}`}
        rows={props.rows ?? 4}
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => {
          props.onInput(e.currentTarget.value);
          update();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) update();
        }}
        onClick={update}
        onBlur={() => {
          window.setTimeout(() => setQuery(null), 150);
          props.onBlur?.();
        }}
      />
      <Show when={query() && hits().length > 0}>
        <ul class="absolute z-30 mt-1 max-h-64 w-80 overflow-auto rounded-md border border-line bg-panel py-1 shadow-lg">
          <For each={hits()}>
            {(hit, i) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                  data-active={i() === active()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(hit);
                  }}
                >
                  <span class="w-14 shrink-0 text-xs text-faint">
                    {TYPE_LABEL[hit.type] ?? hit.type}
                  </span>
                  <span class="truncate">{hit.title || "Untitled"}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
