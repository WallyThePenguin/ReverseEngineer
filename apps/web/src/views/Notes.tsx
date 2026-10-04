// Notes: a list and a page per note. Checklists can become tasks in one click (Jarvis also
// offers to, a few minutes after you stop editing).

import { createSignal, For, lazy, Show, useContext } from "solid-js";
import { Backlinks } from "../components/Backlinks.tsx";
import { Comments, JarvisWorking } from "../components/Comments.tsx";
import { DocHistory } from "../components/DocHistory.tsx";
import { Overflow, ROW_MENU } from "../components/Menu.tsx";
import { Button, Empty, PaneContext, PaneHeader, Placeholder } from "../components/ui.tsx";
import { ago, who } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { createSelection } from "../lib/selection.ts";
import { moveToTrash, trashKey } from "../lib/trash.ts";
import type { Entity, NoteRow } from "../lib/types.ts";
import { undoImport } from "./ImportSettings.tsx";

// The editor and its CRDT are big, so they load when a note opens.
const DocEditor = lazy(() => import("../components/DocEditor.tsx"));

/** The note just made here, whose title box takes the cursor when it opens. */
let justMade: string | null = null;

export async function newNote(pane: number) {
  const made = await act<Entity>("note.create", { title: "Untitled" });
  if (!made) return;
  justMade = made.id;
  layout.open({ view: "note", id: made.id }, { pane });
}

export function Notes(props: { pane: number }) {
  const notes = useAction<NoteRow[]>("note.list", () => ({ limit: 100 }));
  const list = () => notes.data ?? [];
  const sel = createSelection(list, (n) => n.id);
  const focused = () => layout.focused() === props.pane;
  const open = (n: NoteRow | undefined, beside = false) => {
    if (!n) return;
    if (beside) layout.open({ view: "note", id: n.id }, { beside: true });
    else layout.show({ view: "note", id: n.id }, props.pane);
  };

  useHotkeys([
    ...listKeys({
      count: () => list().length,
      index: sel.index,
      setIndex: sel.select,
      when: focused,
    }),
    { keys: "enter", run: () => open(sel.current()), when: focused, label: "Open note" },
    trashKey(sel.current, focused),
    { keys: "c", run: () => void newNote(props.pane), when: focused, label: "New note" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Notes">
        <Button kind="primary" small onClick={() => void newNote(props.pane)}>
          New note
        </Button>
      </PaneHeader>
      <div class="flex-1 overflow-auto">
        <Show
          when={list().length > 0}
          fallback={<Empty>{notes.isLoading ? "Loading…" : "No notes yet."}</Empty>}
        >
          <ul>
            <For each={list()}>
              {(n, i) => (
                <li
                  class="group flex cursor-pointer items-center gap-2 border-b border-line py-2 pr-2 pl-4 md:py-2.5"
                  data-active={focused() && i() === sel.index()}
                  onClick={(e) => {
                    sel.select(i());
                    open(n, e.shiftKey);
                  }}
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-3">
                      <span class="min-w-0 flex-1 truncate font-medium">
                        {n.title || "Untitled"}
                      </span>
                      <span class="shrink-0 text-xs text-faint">{ago(n.updatedAt)}</span>
                    </div>
                    <Show when={n.preview}>
                      <p class="truncate text-sm text-muted">{n.preview}</p>
                    </Show>
                  </div>
                  <Overflow
                    class={ROW_MENU}
                    label={`Actions for ${n.title || "Untitled"}`}
                    items={[
                      { label: "Move to trash", danger: true, run: () => void moveToTrash(n.id) },
                    ]}
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

export function NoteView(props: { id: string; pane: number }) {
  const note = useAction<Entity>("entity.get", () => ({ id: props.id }));
  const pane = useContext(PaneContext);

  // The text saves itself as you type; this is the title.
  const save = async (fields: { title: string }) => {
    const n = note.data;
    if (!n) return false;
    return (await act("note.update", { id: n.id, ...fields })) !== null;
  };
  const extract = async () => {
    const r = await act<{ created: { title: string }[] }>("note.extract_tasks", { id: props.id });
    const n = r?.created.length ?? 0;
    if (r)
      toast.show(
        n
          ? `Made ${n} task${n === 1 ? "" : "s"}, linked from the checklist.`
          : "No open checklist items to turn into tasks.",
      );
  };
  const [history, setHistory] = createSignal(false);
  // An item already turned into a task is a link to it, and doesn't count.
  const hasChecklist = () => /^\s*[-*] \[ \] (?!<m-ref)\S/m.test(note.data?.body ?? "");

  return (
    <Show when={note.data} fallback={<Placeholder missing={note.isError} what="note" />}>
      {(n) => (
        <div class="flex h-full flex-col">
          <PaneHeader
            title="Note"
            sub={`Edited by ${who(n().updatedBy)} ${ago(n().updatedAt)}`}
            record={{ id: n().id, type: "note", trashed: n().deletedAt !== null }}
            menu={
              n().createdBy === "integration:notion" && !n().parentId
                ? [
                    {
                      label: "Undo this import",
                      danger: true,
                      run: async () => {
                        if ((await undoImport(n().id)) && pane.close) pane.close();
                      },
                    },
                  ]
                : []
            }
          >
            <Show when={hasChecklist()}>
              <Button
                small
                onClick={() => void extract()}
                title="Make a task for each open checklist item"
              >
                Checklist → tasks
              </Button>
            </Show>
            <Button
              small
              onClick={() => setHistory(!history())}
              title="See and restore earlier versions"
            >
              {history() ? "Close history" : "History"}
            </Button>
          </PaneHeader>
          <div class="flex-1 space-y-5 overflow-auto px-5 py-4">
            <input
              ref={(el) => {
                // A note you just made: its name is the first thing you type.
                if (n().id === justMade) {
                  justMade = null;
                  queueMicrotask(() => el.focus());
                }
              }}
              class="w-full bg-transparent text-2xl font-semibold outline-none"
              aria-label="Note title"
              value={n().title === "Untitled" ? "" : n().title}
              placeholder="Untitled"
              onChange={(e) => {
                const title = e.currentTarget.value.trim() || "Untitled";
                if (title !== n().title) void save({ title });
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <JarvisWorking subjectId={n().id} />
            <Show
              when={history()}
              fallback={
                <DocEditor
                  id={n().id}
                  placeholder="Start writing… type @ to link anything, or @Jarvis to ask for help."
                />
              }
            >
              <DocHistory id={n().id} onClose={() => setHistory(false)} />
            </Show>
            <Comments parentId={n().id} />
            <Backlinks id={n().id} />
          </div>
        </div>
      )}
    </Show>
  );
}
