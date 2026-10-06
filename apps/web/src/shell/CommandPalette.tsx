// Cmd+K: jump to anything, run a command, or ask Jarvis. Enter opens, Shift+Enter opens beside,
// Ctrl+Enter asks Jarvis.

import { createEffect, createSignal, For, on, onCleanup } from "solid-js";
import { Kbd } from "../components/ui.tsx";
import { jarvis } from "../jarvis/JarvisPane.tsx";
import { action } from "../lib/api.ts";
import { PLACES, type Place, paletteLabel, placeOf } from "../lib/apps.ts";
import { TYPING_PAUSE_MS } from "../lib/debounce.ts";
import { useDialogFocus } from "../lib/focus.ts";
import { due, TYPE_LABEL } from "../lib/format.ts";
import { MOD } from "../lib/hotkeys.ts";
import { askNewTask } from "../lib/newTask.ts";
import { arrange, type PaletteItem } from "../lib/palette.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { setPaused } from "../lib/pause.ts";
import { act, useAction } from "../lib/query.ts";
import type { SearchHit, SystemStatus } from "../lib/types.ts";
import { readWhen } from "../lib/when.ts";
import { sidebar } from "./Sidebar.tsx";

type Item = PaletteItem;

const go = (p: Place): Item => ({
  id: `go:${p.view}`,
  label: paletteLabel(p),
  hint: "Go",
  run: (beside) => layout.open({ view: p.view }, { beside }),
});

/** What you do most: first when Cmd+K opens. */
function top(): Item[] {
  return [
    go(placeOf("today")),
    { id: "new:task", label: "New task", hint: "Create", run: (beside) => askNewTask(beside) },
    {
      id: "new:email",
      label: "Write email",
      hint: "Create",
      run: async (beside) => {
        // A new message is written at the top of Mail.
        if (await act("mail.draft", { text: "" })) layout.open({ view: "mail" }, { beside });
      },
    },
    { id: "jarvis:ask", label: "Ask Jarvis", hint: "Jarvis", run: () => jarvis.toggle(true) },
  ];
}

/** Docs' lists load when they're opened, so a new one loads its own first. */
const docs = {
  note: () => import("../views/Notes.tsx").then((m) => m.newNote(layout.focused())),
  canvas: () => import("../views/Canvas.tsx").then((m) => m.newCanvas(layout.focused())),
  sheet: () => import("../views/Sheets.tsx").then((m) => m.newSheet(layout.focused())),
};

function commands(paused: boolean | undefined): Item[] {
  return [
    ...PLACES.filter((p) => p.view !== "today").map(go),
    { id: "new:note", label: "New note", hint: "Create", run: docs.note },
    { id: "new:canvas", label: "New canvas board", hint: "Create", run: docs.canvas },
    { id: "new:sheet", label: "New spreadsheet", hint: "Create", run: docs.sheet },
    {
      id: "new:chat",
      label: "New conversation with Jarvis",
      hint: "Jarvis",
      run: () => jarvis.newChat(),
    },
    // Only the one that applies.
    paused
      ? { id: "jarvis:resume", label: "Resume Jarvis", hint: "Jarvis", run: () => setPaused(false) }
      : { id: "jarvis:pause", label: "Pause Jarvis", hint: "Jarvis", run: () => setPaused(true) },
    { id: "pane:split", label: "Split pane", hint: "Layout", run: () => layout.split() },
    { id: "pane:close", label: "Close pane", hint: "Layout", run: () => layout.close() },
    {
      id: "sidebar",
      label: "Show or hide the sidebar",
      hint: "Layout",
      run: () => sidebar.toggle(),
    },
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
  /** The item the arrow keys are on, by id, so results landing don't move it. */
  const [activeId, setActiveId] = createSignal<string | null>(null);
  let input!: HTMLInputElement;
  let dialog: HTMLDivElement | undefined;
  let seq = 0;
  let timer: number | undefined;
  /** Settles once the records for what's typed now are in. */
  let landed: Promise<void> = Promise.resolve();
  let closed = false;
  onCleanup(() => {
    closed = true;
    window.clearTimeout(timer);
  });
  useDialogFocus(() => dialog);
  const status = useAction<SystemStatus>("system.status");

  const search = async (q: string, mine: number) => {
    const found = q
      ? await action<SearchHit[]>("entity.search", { query: q, limit: 8 }).catch(() => [])
      : await action<SearchHit[]>("entity.recent", { limit: 6 }).catch(() => []);
    // An answer for something typed earlier is dropped, not shown over a newer one.
    if (mine !== seq) return;
    setHits({ query: q, list: found.filter((h) => h.type !== "comment") });
  };

  createEffect(
    on(text, (raw) => {
      const q = raw.trim();
      const mine = ++seq;
      setActiveId(null);
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

  /** Whether the records for what's typed now haven't come back yet. */
  const stale = () => hits().query !== text().trim();

  const ask: PaletteItem = {
    id: "ask",
    label: "",
    hint: "Jarvis",
    run: async () => {
      const r = await act<{ conversationId: string }>("chat.send", { text: text().trim() });
      if (r) {
        jarvis.setConversationId(r.conversationId);
        jarvis.toggle(true);
      }
    },
  };

  /**
   * A new task from what's typed. When it names a time ("dentist fri 3pm") the line says the due
   * date, and a second line makes it as typed, so a misread date is one arrow key away.
   */
  const newTask = (q: string): PaletteItem[] => {
    const make = (id: string, label: string, fields: { title: string }): PaletteItem => ({
      id,
      label,
      hint: "Create",
      run: async (beside) => {
        const t = await act<{ id: string }>("task.create", fields);
        if (t) layout.open({ view: "task", id: t.id }, { beside });
      },
    });
    const w = readWhen(q);
    if (!w) return [make("task", `New task: “${q}”`, { title: q })];
    return [
      make("task", `New task: “${w.title}”, due ${due(w.dueAt, w.dueIsDate)?.text}`, w),
      make("task-as-typed", `New task: “${q}” (no date)`, { title: q }),
    ];
  };

  const items = (): PaletteItem[] => {
    const q = text().trim();
    return arrange({
      query: q,
      top: top(),
      commands: commands(status.data?.jarvisPaused),
      records: {
        query: hits().query,
        list: hits().list.map((h) => ({
          id: h.id,
          label: h.title || "Untitled",
          hint: TYPE_LABEL[h.type] ?? h.type,
          run: (beside) => layout.open(routeFor(h.type, h.id), { beside }),
        })),
      },
      extra: q ? [{ ...ask, label: `Ask Jarvis: “${q}”` }, ...newTask(q)] : [],
    });
  };
  const active = () =>
    Math.max(
      0,
      items().findIndex((i) => i.id === activeId()),
    );
  const move = (by: number) => {
    const list = items();
    if (list.length) setActiveId(list[(active() + by + list.length) % list.length]!.id);
  };

  const choose = (item: PaletteItem | undefined, beside: boolean) => {
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
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Search, commands and Jarvis"
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
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items().length ? `palette-${active()}` : undefined}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              // Straight to Jarvis, past whatever matched.
              e.preventDefault();
              if (text().trim()) choose(ask, false);
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
        <div id="palette-list" role="listbox" class="max-h-[50vh] overflow-auto py-1">
          <For each={items()}>
            {(item, i) => (
              <div
                id={`palette-${i()}`}
                role="option"
                tabIndex={-1}
                aria-selected={i() === active()}
                class="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left"
                data-active={i() === active()}
                onMouseEnter={() => setActiveId(item.id)}
                onClick={(e) => choose(item, e.shiftKey)}
              >
                <span class="w-16 shrink-0 text-xs text-muted">{item.hint}</span>
                <span class="flex-1 truncate">{item.label}</span>
              </div>
            )}
          </For>
        </div>
        <div class="hidden gap-4 border-t border-line px-4 py-2 text-xs text-muted md:flex">
          <span>
            <Kbd>Enter</Kbd> open
          </span>
          <span>
            <Kbd>Shift+Enter</Kbd> open beside
          </span>
          <span>
            <Kbd>{MOD}+Enter</Kbd> ask Jarvis
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
