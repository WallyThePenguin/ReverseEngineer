// Cmd+K: jump to anything, run a command, or ask Jarvis. Enter opens, Shift+Enter opens beside.

import { createEffect, createSignal, For, on } from "solid-js";
import { Kbd } from "../components/ui.tsx";
import { jarvis } from "../jarvis/JarvisPane.tsx";
import { action } from "../lib/api.ts";
import { TYPE_LABEL } from "../lib/format.ts";
import { type ListView, layout, routeFor } from "../lib/panes.ts";
import { act } from "../lib/query.ts";
import type { SearchHit } from "../lib/types.ts";
import { newNote } from "../views/Notes.tsx";
import { setPaused } from "../views/Settings.tsx";

interface Item {
  id: string;
  label: string;
  hint: string;
  run: (beside: boolean) => void | Promise<void>;
}

function commands(): Item[] {
  const go = (view: ListView, label: string): Item => ({
    id: `go:${view}`,
    label: `Go to ${label}`,
    hint: "Go",
    run: (beside) => layout.open({ view }, { beside }),
  });
  return [
    go("inbox", "Inbox"),
    go("tasks", "Tasks"),
    go("notes", "Notes"),
    go("calendar", "Calendar"),
    go("people", "People"),
    go("memory", "Memory (what Jarvis remembers)"),
    go("browser", "the browser (your Chrome, live)"),
    go("activity", "Jarvis's activity"),
    go("settings", "Settings"),
    { id: "new:note", label: "New note", hint: "Create", run: () => newNote(layout.focused()) },
    {
      id: "new:chat",
      label: "New conversation with Jarvis",
      hint: "Jarvis",
      run: () => jarvis.newChat(),
    },
    { id: "jarvis:pause", label: "Pause Jarvis", hint: "Jarvis", run: () => setPaused(true) },
    { id: "jarvis:resume", label: "Resume Jarvis", hint: "Jarvis", run: () => setPaused(false) },
    { id: "pane:split", label: "Split pane", hint: "Layout", run: () => layout.split() },
    { id: "pane:close", label: "Close pane", hint: "Layout", run: () => layout.close() },
  ];
}

export function CommandPalette(props: { onClose: () => void }) {
  const [text, setText] = createSignal("");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;
  let seq = 0;

  createEffect(
    on(text, async (q) => {
      const mine = ++seq;
      const found = q.trim()
        ? await action<SearchHit[]>("entity.search", { query: q, limit: 8 }).catch(() => [])
        : await action<SearchHit[]>("entity.recent", { limit: 6 }).catch(() => []);
      if (mine === seq) setHits(found.filter((h) => h.type !== "comment"));
      setActive(0);
    }),
  );

  const items = (): Item[] => {
    const q = text().trim().toLowerCase();
    const cmds = commands().filter((c) => !q || c.label.toLowerCase().includes(q));
    const records: Item[] = hits().map((h) => ({
      id: h.id,
      label: h.title || "Untitled",
      hint: TYPE_LABEL[h.type] ?? h.type,
      run: (beside) => layout.open(routeFor(h.type, h.id), { beside }),
    }));
    const extra: Item[] = q
      ? [
          {
            id: "ask",
            label: `Ask Jarvis: “${text().trim()}”`,
            hint: "Jarvis",
            run: async () => {
              const r = await act<{ conversationId: string }>("chat.send", { text: text().trim() });
              if (r) {
                jarvis.setConversationId(r.conversationId);
                jarvis.toggle(true);
              }
            },
          },
          {
            id: "task",
            label: `New task: “${text().trim()}”`,
            hint: "Create",
            run: async (beside) => {
              const t = await act<{ id: string }>("task.create", { title: text().trim() });
              if (t) layout.open({ view: "task", id: t.id }, { beside });
            },
          },
        ]
      : [];
    return [...records, ...cmds.slice(0, q ? 4 : 12), ...extra];
  };

  const choose = (item: Item | undefined, beside: boolean) => {
    if (!item) return;
    props.onClose();
    void item.run(beside);
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]"
      onClick={props.onClose}
    >
      <div
        class="w-[min(640px,92vw)] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={(el) => {
            input = el;
            queueMicrotask(() => input.focus());
          }}
          class="w-full border-b border-line bg-transparent px-4 py-3 text-base outline-none"
          placeholder="Search, run a command, or ask Jarvis…"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            const n = items().length;
            if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
              e.preventDefault();
              setActive((a) => (a + 1) % Math.max(n, 1));
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              setActive((a) => (a + n - 1) % Math.max(n, 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(items()[active()], e.shiftKey);
            } else if (e.key === "Escape") {
              e.preventDefault();
              props.onClose();
            }
          }}
        />
        <ul class="max-h-[50vh] overflow-auto py-1">
          <For each={items()}>
            {(item, i) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-3 px-4 py-2 text-left"
                  data-active={i() === active()}
                  onMouseEnter={() => setActive(i())}
                  onClick={(e) => choose(item, e.shiftKey)}
                >
                  <span class="w-16 shrink-0 text-xs text-faint">{item.hint}</span>
                  <span class="flex-1 truncate">{item.label}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <div class="flex gap-4 border-t border-line px-4 py-2 text-xs text-faint">
          <span>
            <Kbd>Enter</Kbd> open
          </span>
          <span>
            <Kbd>Shift+Enter</Kbd> open beside
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
