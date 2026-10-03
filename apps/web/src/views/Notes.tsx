// Notes: a list and a page per note. Checklists can become tasks in one click (Jarvis also
// offers to, a few minutes after you stop editing).

import { createSignal, For, lazy, Show } from "solid-js";
import { Backlinks } from "../components/Backlinks.tsx";
import { Comments, JarvisWorking } from "../components/Comments.tsx";
import { DocHistory } from "../components/DocHistory.tsx";
import { Button, Empty, PaneHeader, Placeholder } from "../components/ui.tsx";
import { ago, who } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { Entity, NoteRow } from "../lib/types.ts";

// The editor and its CRDT are big, so they load when a note opens.
const DocEditor = lazy(() => import("../components/DocEditor.tsx"));

export async function newNote(pane: number) {
  const made = await act<Entity>("note.create", { title: "Untitled" });
  if (made) layout.open({ view: "note", id: made.id }, { pane });
}

export function Notes(props: { pane: number }) {
  const notes = useAction<NoteRow[]>("note.list", () => ({ limit: 100 }));
  const [index, setIndex] = createSignal(0);
  const list = () => notes.data ?? [];
  const focused = () => layout.focused() === props.pane;
  const open = (n: NoteRow | undefined, beside = false) => {
    if (!n) return;
    if (beside) layout.open({ view: "note", id: n.id }, { beside: true });
    else layout.show({ view: "note", id: n.id }, props.pane);
  };

  useHotkeys([
    ...listKeys({ count: () => list().length, index, setIndex, when: focused }),
    { keys: "enter", run: () => open(list()[index()]), when: focused, label: "Open note" },
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
                  class="cursor-pointer border-b border-line px-4 py-2.5"
                  data-active={focused() && i() === index()}
                  onClick={(e) => {
                    setIndex(i());
                    open(n, e.shiftKey);
                  }}
                >
                  <div class="flex items-baseline gap-3">
                    <span class="min-w-0 flex-1 truncate font-medium">{n.title || "Untitled"}</span>
                    <span class="shrink-0 text-xs text-faint">{ago(n.updatedAt)}</span>
                  </div>
                  <Show when={n.preview}>
                    <p class="truncate text-sm text-muted">{n.preview}</p>
                  </Show>
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
  const hasChecklist = () => /^\s*[-*] \[ \] \S/m.test(note.data?.body ?? "");

  return (
    <Show when={note.data} fallback={<Placeholder missing={note.isError} what="note" />}>
      {(n) => (
        <div class="flex h-full flex-col">
          <PaneHeader title="Note" sub={`Edited by ${who(n().updatedBy)} ${ago(n().updatedAt)}`}>
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
              class="w-full bg-transparent text-2xl font-semibold outline-none"
              value={n().title}
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
