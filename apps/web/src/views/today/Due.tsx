// Today's "Due": open tasks that are late, then the ones due today, each ticked off with one tap
// (with Undo, in case the tap was a slip).

import { createSignal, For, Show } from "solid-js";
import { Checkbox } from "../../components/kit/Checkbox.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { due } from "../../lib/format.ts";
import { toast } from "../../lib/live.ts";
import { layout } from "../../lib/panes.ts";
import { act } from "../../lib/query.ts";
import type { Task } from "../../lib/types.ts";
import { CardEmpty, CardWaiting, TodayCard, TodayRow } from "./parts.tsx";

export function Due(props: {
  query: QueryRead<unknown>;
  overdue: readonly Task[];
  today: readonly Task[];
  now: Date;
}) {
  // Ticked here, until the list catches up and lets it go.
  const [ticked, setTicked] = createSignal<ReadonlySet<string>>(new Set());
  const tick = (id: string, on: boolean) =>
    setTicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const complete = async (t: Task) => {
    tick(t.id, true);
    const done = await act("task.update", { id: t.id, status: "completed" });
    if (!done) return tick(t.id, false);
    toast.show(`Done: ${t.title}`, "info", {
      label: "Undo",
      run: () => {
        tick(t.id, false);
        void act("task.update", { id: t.id, status: t.status });
      },
    });
  };
  const count = () => props.overdue.length + props.today.length;

  const row = (t: Task, late: boolean) => {
    const when = () => due(t.dueAt, t.dueIsDate, props.now)?.text ?? "";
    return (
      <TodayRow
        lead={
          <Checkbox
            round
            class="-my-3 -ml-3 md:m-0"
            checked={ticked().has(t.id)}
            disabled={ticked().has(t.id)}
            label={`Complete ${t.key}`}
            onChange={(on) => on && void complete(t)}
          />
        }
        title={<span class={ticked().has(t.id) ? "text-muted line-through" : ""}>{t.title}</span>}
        meta={
          late ? (
            <span class="font-medium text-bad">Late · was due {when()}</span>
          ) : t.dueIsDate ? (
            "Due today"
          ) : (
            `Due ${when()}`
          )
        }
        onOpen={(beside) => layout.open({ view: "task", id: t.id }, { beside })}
      />
    );
  };

  return (
    <TodayCard
      product="tasks"
      icon="tasks"
      title="Due"
      count={count()}
      more={{ run: () => layout.open({ view: "tasks" }) }}
    >
      <Show
        when={props.query.data !== undefined}
        fallback={<CardWaiting query={props.query} what="your tasks" />}
      >
        <Show when={count() > 0} fallback={<CardEmpty>Nothing due today.</CardEmpty>}>
          <ul>
            <For each={props.overdue}>{(t) => row(t, true)}</For>
            <For each={props.today}>{(t) => row(t, false)}</For>
          </ul>
        </Show>
      </Show>
    </TodayCard>
  );
}
