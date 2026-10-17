// Tasks: quick add, filter by who's on it, j/k to move, x to complete, Enter to open.
// Assign a task to Jarvis and it starts working on it.

import { createEffect, createSignal, For, Show } from "solid-js";
import { Overflow, ROW_MENU } from "../components/Menu.tsx";
import { QueryView } from "../components/QueryView.tsx";
import { Badge, Empty, Kbd, PaneHeader } from "../components/ui.tsx";
import { useWhen, WhenChip } from "../components/WhenChip.tsx";
import { due, PRIORITY_LABEL } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { narrow } from "../lib/narrow.ts";
import { newTaskTaken, newTaskWanted } from "../lib/newTask.ts";
import { orBack } from "../lib/orBack.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { quickAdd } from "../lib/quickadd.ts";
import { createSelection } from "../lib/selection.ts";
import { moveToTrash, trashKey } from "../lib/trash.ts";
import type { Task } from "../lib/types.ts";

type Filter = "open" | "mine" | "jarvis" | "done";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "mine", label: "Mine" },
  { id: "jarvis", label: "Pip" },
  { id: "done", label: "Done" },
];

function query(f: Filter) {
  if (f === "done") return { status: ["completed", "canceled"], includeClosed: true, limit: 100 };
  if (f === "mine") return { assignee: "owner", limit: 200 };
  if (f === "jarvis") return { assignee: "jarvis", limit: 200 };
  return { limit: 200 };
}

export function TaskRow(props: { task: Task; active: boolean; onOpen: (beside: boolean) => void }) {
  const t = () => props.task;
  const d = () => due(t().dueAt, t().dueIsDate);
  const closed = () => t().status === "completed" || t().status === "canceled";
  return (
    <li
      class="group flex cursor-pointer items-center gap-3 border-b border-line py-1 pr-2 pl-4 md:py-2"
      data-active={props.active}
      onClick={(e) => props.onOpen(e.shiftKey)}
    >
      {/* The whole square around the box takes the tap on a phone. */}
      <label
        class="-ml-3 flex size-11 shrink-0 cursor-pointer items-center justify-center md:m-0 md:size-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          class="size-4 accent-[var(--color-accent)] md:size-auto"
          aria-label={closed() ? `Reopen ${t().key}` : `Complete ${t().key}`}
          checked={t().status === "completed"}
          onChange={(e) =>
            void orBack(
              e.currentTarget,
              act("task.update", {
                id: t().id,
                status: e.currentTarget.checked ? "completed" : "not_started",
              }),
              () => t().status === "completed",
            )
          }
        />
      </label>
      <span class="w-12 shrink-0 font-mono text-xs text-faint">{t().key}</span>
      <span class={`min-w-0 flex-1 truncate ${closed() ? "text-muted line-through" : ""}`}>
        {t().title}
      </span>
      <Show when={t().status === "in_progress" || t().status === "in_review"}>
        <Badge>{t().status === "in_progress" ? "In progress" : "In review"}</Badge>
      </Show>
      <Show when={t().priority === "urgent" || t().priority === "high"}>
        <Badge tone={t().priority === "urgent" ? "bad" : "warn"}>
          {PRIORITY_LABEL[t().priority]}
        </Badge>
      </Show>
      <Show when={t().assignee === "jarvis"}>
        <Badge tone="jarvis">Pip</Badge>
      </Show>
      <Show when={d() && !closed()}>
        <span
          class={`shrink-0 text-xs ${d()!.overdue ? "text-bad" : d()!.soon ? "text-warn" : "text-muted"}`}
        >
          {d()!.text}
        </span>
      </Show>
      <Overflow
        class={ROW_MENU}
        label={`Actions for ${t().key}`}
        items={[
          {
            label: closed() ? "Reopen" : "Complete",
            run: () =>
              void act("task.update", {
                id: t().id,
                status: closed() ? "not_started" : "completed",
              }),
          },
          { label: "Move to trash", danger: true, run: () => void moveToTrash(t().id) },
        ]}
      />
    </li>
  );
}

export function Tasks(props: { pane: number }) {
  const [filter, setFilter] = createSignal<Filter>("open");
  const [title, setTitle] = createSignal("");
  const [forJarvis, setForJarvis] = createSignal(false);
  const tasks = useAction<Task[]>("task.list", () => query(filter()));
  // Subtasks show inside their parent.
  const list = () => (tasks.data ?? []).filter((t) => !t.parentId);
  const sel = createSelection(list, (t) => t.id);
  const focused = () => layout.focused() === props.pane;
  let input!: HTMLInputElement;
  // Cmd+K's New task, or Today's: the add box, ready to type in, with what you'd typed there.
  createEffect(() => {
    if (!newTaskWanted() || !focused()) return;
    const typed = newTaskTaken();
    if (typed) setTitle(typed);
    input.focus();
  });

  const open = (t: Task | undefined, beside = false) => {
    if (!t) return;
    if (beside) layout.open({ view: "task", id: t.id }, { beside: true });
    else layout.show({ view: "task", id: t.id }, props.pane);
  };

  // "call dentist tomorrow 10am" is due tomorrow at 10, shown as a chip before it's added.
  const when = useWhen(title);
  const create = async () => {
    const jarvis = forJarvis();
    const fields = when.fields();
    const made = await quickAdd({ get: title, set: setTitle }, (text) =>
      act<Task>("task.create", {
        ...fields(text),
        ...(jarvis ? { assignee: "jarvis" } : {}),
      }),
    );
    if (made && jarvis) toast.show(`${made.key} is Pip's now. It'll start shortly.`);
  };

  useHotkeys([
    ...listKeys({
      count: () => list().length,
      index: sel.index,
      setIndex: sel.select,
      when: focused,
    }),
    { keys: "enter", run: () => open(sel.current()), when: focused, label: "Open task" },
    {
      keys: "x",
      when: focused,
      label: "Complete",
      run: () => {
        const t = sel.current();
        if (t)
          void act("task.update", {
            id: t.id,
            status: t.status === "completed" ? "not_started" : "completed",
          });
      },
    },
    trashKey(sel.current, focused),
    { keys: "c", run: () => input.focus(), when: focused, label: "New task" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Tasks">
        <For each={FILTERS}>
          {(f) => (
            <button
              type="button"
              class={`min-h-11 min-w-11 rounded-md px-2 py-1 text-sm md:min-h-0 md:min-w-0 ${filter() === f.id ? "bg-sunk font-medium" : "text-muted hover:text-ink"}`}
              aria-pressed={filter() === f.id}
              onClick={() => {
                setFilter(f.id);
                sel.reset();
              }}
            >
              {f.label}
            </button>
          )}
        </For>
      </PaneHeader>
      <form
        class="flex items-center gap-2 border-b border-line px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          ref={input}
          class="min-w-0 flex-1 bg-transparent py-1 outline-none placeholder:text-faint"
          placeholder={narrow() ? "New task…" : "New task… (press c)"}
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && input.blur()}
        />
        <WhenChip box={when} />
        <label
          class="flex min-h-11 items-center gap-1 text-xs text-muted md:min-h-0"
          title="Pip works on tasks assigned to it"
        >
          <input
            type="checkbox"
            checked={forJarvis()}
            onChange={(e) => setForJarvis(e.currentTarget.checked)}
          />
          For Pip
        </label>
        <span class="hidden md:inline">
          <Kbd>Enter</Kbd>
        </span>
      </form>
      <div class="flex-1 overflow-auto">
        <QueryView
          query={tasks}
          what="your tasks"
          isEmpty={() => list().length === 0}
          empty={<Empty>No tasks here.</Empty>}
        >
          {() => (
            <ul>
              <For each={list()}>
                {(t, i) => (
                  <TaskRow
                    task={t}
                    active={focused() && i() === sel.index()}
                    onOpen={(beside) => {
                      sel.select(i());
                      open(t, beside);
                    }}
                  />
                )}
              </For>
            </ul>
          )}
        </QueryView>
      </div>
    </div>
  );
}
