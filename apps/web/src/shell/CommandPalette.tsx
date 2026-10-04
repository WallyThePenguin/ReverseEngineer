// Cmd+K: jump to anything, run a command, or ask Jarvis. Enter opens, Shift+Enter opens beside.

import { createEffect, createSignal, For, on, onCleanup } from "solid-js";
import { Kbd } from "../components/ui.tsx";
import { jarvis } from "../jarvis/JarvisPane.tsx";
import { action } from "../lib/api.ts";
import { TYPING_PAUSE_MS } from "../lib/debounce.ts";
import { TYPE_LABEL } from "../lib/format.ts";
import { type ListView, layout, routeFor } from "../lib/panes.ts";
import { act } from "../lib/query.ts";
import type { SearchHit } from "../lib/types.ts";
import { newCanvas } from "../views/Canvas.tsx";
import { newNote } from "../views/Notes.tsx";
import { setPaused } from "../views/Settings.tsx";
import { newSheet } from "../views/Sheets.tsx";

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
    go("mail", "Mail"),
    go("tasks", "Tasks"),
    go("notes", "Notes"),
    go("calendar", "Calendar"),
    go("canvases", "Canvas (boards)"),
    go("sheets", "Spreadsheets"),
    go("people", "People"),
    go("memory", "Memory (what Jarvis remembers)"),
    go("voice", "Voice (dictation history, dictionary, snippets)"),
    go("browser", "the browser (your Chrome, live)"),
    go("activity", "Jarvis's activity"),
    go("settings", "Settings"),
    { id: "new:note", label: "New note", hint: "Create", run: () => newNote(layout.focused()) },
    {
      id: "new:canvas",
      label: "New canvas board",
      hint: "Create",
      run: () => newCanvas(layout.focused()),
    },
    {
      id: "new:sheet",
      label: "New spreadsheet",
      hint: "Create",
      run: () => newSheet(layout.focused()),
    },
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

/** How long Enter waits for the results for what's typed before going with what's shown. */
const ENTER_WAITS_MS = 1500;
const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function CommandPalette(props: { onClose: () => void }) {
  const [text, setText] = createSignal("");
  /** Records found, and the text they were found for. */
  const [hits, setHits] = createSignal<{ query: string; list: SearchHit[] }>({
    query: "",
    list: [],
  });
  const [active, setActive] = createSignal(0);
  let input!: HTMLInputElement;
  let seq = 0;
  let timer: number | undefined;
  /** Settles once the records for what's typed now are in. */
  let landed: Promise<void> = Promise.resolve();
  let closed = false;
  onCleanup(() => {
    closed = true;
    window.clearTimeout(timer);
  });

  const search = async (q: string, mine: number) => {
    const found = q
      ? await action<SearchHit[]>("entity.search", { query: q, limit: 8 }).catch(() => [])
      : await action<SearchHit[]>("entity.recent", { limit: 6 }).catch(() => []);
    // An answer for something typed earlier is dropped, not shown over a newer one.
    if (mine !== seq) return;
    setHits({ query: q, list: found.filter((h) => h.type !== "comment") });
    setActive(0);
  };

  createEffect(
    on(text, (raw) => {
      const q = raw.trim();
      const mine = ++seq;
      setActive(0);
      window.clearTimeout(timer);
      // Searches go out once typing pauses, not for every letter.
      landed = new Promise((done) => {
        timer = window.setTimeout(
          () => void search(q, mine).finally(done),
          q ? TYPING_PAUSE_MS : 0,
        );
      });
    }),
  );

  /** Whether the records shown were found for an earlier version of what's typed. */
  const stale = () => hits().query !== text().trim();

  const items = (): Item[] => {
    const q = text().trim().toLowerCase();
    const cmds = commands().filter((c) => !q || c.label.toLowerCase().includes(q));
    const records: Item[] = hits().list.map((h) => ({
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
              const beside = e.shiftKey;
              // Typed quickly then Enter: open what matches what's typed, not the last letter's.
              if (!stale()) choose(items()[active()], beside);
              else
                void Promise.race([landed, wait(ENTER_WAITS_MS)]).then(() => {
                  if (!closed) choose(items()[active()], beside);
                });
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
