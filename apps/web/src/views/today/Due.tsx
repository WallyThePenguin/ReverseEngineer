// Today's "Due": your open tasks that are late, then the ones due today, each ticked off with one
// tap (with Undo, in case the tap was a slip). A long list stops after a few, with the rest in
// Tasks, so a backlog doesn't take over the morning.

import { createSignal, For, Show } from "solid-js";
import { Checkbox } from "../../components/kit/Checkbox.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { due } from "../../lib/format.ts";
import { toast } from "../../lib/live.ts";
import { act } from "../../lib/query.ts";
import type { Task } from "../../lib/types.ts";
import { CardEmpty, CardWaiting, type Go, TodayCard, TodayRow } from "./parts.tsx";

/** How many tasks the card lists; the rest are a tap away in Tasks. */
const SHOWN = 6;

export function Due(props: {
  query: QueryRead<unknown>;
  overdue: readonly Task[];
  today: readonly Task[];
  now: Date;
  go: Go;
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
  // The late ones first, then today's, up to SHOWN in all.
  const late = () => props.overdue.slice(0, SHOWN);
  const today = () => props.today.slice(0, Math.max(0, SHOWN - late().length));
  const more = () => count() - late().length - today().length;

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
        onOpen={(beside) => props.go({ view: "task", id: t.id }, beside)}
      />
    );
  };

  return (
    <TodayCard
      product="tasks"
      icon="tasks"
      title="Due"
      count={count()}
      more={{ run: () => props.go({ view: "tasks" }) }}
      jump="today-due"
    >
      <Show
        when={props.query.data !== undefined}
        fallback={<CardWaiting query={props.query} what="your tasks" />}
      >
        <Show when={count() > 0} fallback={<CardEmpty>Nothing due today.</CardEmpty>}>
          <ul>
            <For each={late()}>{(t) => row(t, true)}</For>
            <For each={today()}>{(t) => row(t, false)}</For>
            <Show when={more() > 0}>
              <TodayRow
                title={<span class="text-muted">{`${more()} more in Tasks`}</span>}
                onOpen={(beside) => props.go({ view: "tasks" }, beside)}
              />
            </Show>
          </ul>
        </Show>
      </Show>
    </TodayCard>
  );
}
