// One task: its fields, description, subtasks, thread and links.

import { createMemo, createSignal, For, Show } from "solid-js";
import { Backlinks } from "../components/Backlinks.tsx";
import { Comments, JarvisWorking } from "../components/Comments.tsx";
import { EditableBody, toggleLine } from "../components/EditableBody.tsx";
import { Button, PaneHeader, Placeholder } from "../components/ui.tsx";
import { ago, PRIORITY_LABEL, STATUS_LABEL, who } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { Task } from "../lib/types.ts";
import { TaskRow } from "./Tasks.tsx";

/** "2026-10-02T15:00:00Z" → the value a datetime-local input wants, in your time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const select = "rounded-md border border-line bg-panel px-2 py-1 text-sm";

export function TaskView(props: { id: string; pane: number }) {
  const task = useAction<Task>("task.get", () => ({ id: props.id }));
  // The title box follows the saved title only when that changes, so a read of the task landing
  // while you type (any task changing re-reads it) doesn't put the old title back.
  const savedTitle = createMemo(() => task.data?.title);
  const subs = useAction<Task[]>("task.list", () => ({
    parentId: props.id,
    includeClosed: true,
    limit: 200,
  }));
  const subtasks = () => subs.data ?? [];
  const [subtask, setSubtask] = createSignal("");

  const update = async (fields: Record<string, unknown>, withRevision = false) => {
    const t = task.data;
    if (!t) return false;
    const r = await act("task.update", {
      id: t.id,
      ...fields,
      ...(withRevision ? { revision: t.revision } : {}),
    });
    return r !== null;
  };

  const addSubtask = async () => {
    const title = subtask().trim();
    if (!title) return;
    if (await act("task.create", { title, parentId: props.id })) setSubtask("");
  };

  return (
    <Show when={task.data} fallback={<Placeholder missing={task.isError} what="task" />}>
      {(t) => (
        <div class="flex h-full flex-col">
          <PaneHeader
            title={<span class="font-mono text-sm text-muted">{t().key}</span>}
            sub={`Created by ${who(t().createdBy)} ${ago(t().createdAt)}`}
          >
            <Show
              when={t().assignee !== "jarvis"}
              fallback={
                <Button small onClick={() => void update({ assignee: "owner" })}>
                  Take it back
                </Button>
              }
            >
              <Button
                kind="jarvis"
                small
                title="Jarvis will work on this and report back in the thread"
                onClick={async () => {
                  if (await update({ assignee: "jarvis" })) toast.show("Jarvis has it.");
                }}
              >
                Give to Jarvis
              </Button>
            </Show>
          </PaneHeader>
          <div class="flex-1 space-y-5 overflow-auto px-5 py-4">
            <input
              class="w-full bg-transparent text-xl font-semibold outline-none"
              value={savedTitle()}
              onChange={(e) => {
                const title = e.currentTarget.value.trim();
                if (title && title !== t().title) void update({ title });
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <div class="flex flex-wrap items-center gap-2">
              <select
                class={select}
                value={t().status}
                onChange={(e) => void update({ status: e.currentTarget.value })}
              >
                <For each={Object.entries(STATUS_LABEL)}>
                  {([v, l]) => <option value={v}>{l}</option>}
                </For>
              </select>
              <select
                class={select}
                value={t().priority}
                onChange={(e) => void update({ priority: e.currentTarget.value })}
              >
                <For each={Object.entries(PRIORITY_LABEL)}>
                  {([v, l]) => <option value={v}>{l}</option>}
                </For>
              </select>
              <select
                class={select}
                value={t().assignee ?? ""}
                onChange={(e) => void update({ assignee: e.currentTarget.value || null })}
              >
                <option value="">Nobody</option>
                <option value="owner">Me</option>
                <option value="jarvis">Jarvis</option>
              </select>
              <label class="flex items-center gap-1 text-sm text-muted">
                Due
                <input
                  type="datetime-local"
                  class={select}
                  value={toLocalInput(t().dueAt)}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    void update({ dueAt: v ? new Date(v).toISOString() : null, dueIsDate: false });
                  }}
                />
              </label>
            </div>
            <JarvisWorking subjectId={t().id} />
            <EditableBody
              body={t().body}
              placeholder="Add details…"
              save={(body) => update({ body }, true)}
              onToggleLine={(line) => void update({ body: toggleLine(t().body, line) }, true)}
            />
            <section class="space-y-1">
              <h3 class="text-xs font-medium uppercase tracking-wide text-faint">Subtasks</h3>
              <ul class="-mx-4">
                <For each={subtasks()}>
                  {(s) => (
                    <TaskRow
                      task={s}
                      active={false}
                      onOpen={(beside) =>
                        layout.open({ view: "task", id: s.id }, { beside, pane: props.pane })
                      }
                    />
                  )}
                </For>
              </ul>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void addSubtask();
                }}
              >
                <input
                  class="w-full bg-transparent py-1 text-sm outline-none placeholder:text-faint"
                  placeholder="Add a subtask…"
                  value={subtask()}
                  onInput={(e) => setSubtask(e.currentTarget.value)}
                />
              </form>
            </section>
            <Comments parentId={t().id} />
            <Backlinks id={t().id} />
          </div>
        </div>
      )}
    </Show>
  );
}
