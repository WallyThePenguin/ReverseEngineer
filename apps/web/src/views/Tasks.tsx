// Tasks: quick add, filter by who's on it, j/k to move, x to complete, Enter to open.
// Assign a task to Jarvis and it starts working on it.

import { createSignal, For, Show } from "solid-js";
import { Badge, Empty, Kbd, PaneHeader } from "../components/ui.tsx";
import { due, PRIORITY_LABEL } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { createSelection } from "../lib/selection.ts";
import type { Task } from "../lib/types.ts";

type Filter = "open" | "mine" | "jarvis" | "done";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "mine", label: "Mine" },
  { id: "jarvis", label: "Jarvis" },
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
      class="flex cursor-pointer items-center gap-3 border-b border-line px-4 py-2"
      data-active={props.active}
      onClick={(e) => props.onOpen(e.shiftKey)}
    >
      <input
        type="checkbox"
        class="accent-[var(--color-accent)]"
        checked={t().status === "completed"}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) =>
          void act("task.update", {
            id: t().id,
            status: e.currentTarget.checked ? "completed" : "not_started",
          })
        }
      />
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
        <Badge tone="jarvis">Jarvis</Badge>
      </Show>
      <Show when={d() && !closed()}>
        <span
          class={`shrink-0 text-xs ${d()!.overdue ? "text-bad" : d()!.soon ? "text-warn" : "text-muted"}`}
        >
          {d()!.text}
        </span>
      </Show>
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

  const open = (t: Task | undefined, beside = false) => {
    if (!t) return;
    if (beside) layout.open({ view: "task", id: t.id }, { beside: true });
    else layout.show({ view: "task", id: t.id }, props.pane);
  };

  const create = async () => {
    const text = title().trim();
    if (!text) return;
    const made = await act<Task>("task.create", {
      title: text,
      ...(forJarvis() ? { assignee: "jarvis" } : {}),
    });
    if (made) {
      setTitle("");
      if (forJarvis()) toast.show(`${made.key} is Jarvis's now. It'll start shortly.`);
    }
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
    { keys: "c", run: () => input.focus(), when: focused, label: "New task" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Tasks">
        <For each={FILTERS}>
          {(f) => (
            <button
              type="button"
              class={`rounded-md px-2 py-1 text-sm ${filter() === f.id ? "bg-sunk font-medium" : "text-muted hover:text-ink"}`}
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
          placeholder="New task… (press c)"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && input.blur()}
        />
        <label
          class="flex items-center gap-1 text-xs text-muted"
          title="Jarvis works on tasks assigned to it"
        >
          <input
            type="checkbox"
            checked={forJarvis()}
            onChange={(e) => setForJarvis(e.currentTarget.checked)}
          />
          For Jarvis
        </label>
        <Kbd>Enter</Kbd>
      </form>
      <div class="flex-1 overflow-auto">
        <Show when={!tasks.isLoading} fallback={<Empty>Loading…</Empty>}>
          <Show when={list().length > 0} fallback={<Empty>No tasks here.</Empty>}>
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
          </Show>
        </Show>
      </div>
    </div>
  );
}
