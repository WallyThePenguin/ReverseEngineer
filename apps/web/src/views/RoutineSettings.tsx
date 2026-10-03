// Settings > Routines: what Jarvis does for you on a schedule, in your words. You can also ask
// Jarvis in chat ("every weekday at 7, check...") and it makes one here.

import { createSignal, For, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";

interface Routine {
  id: string;
  title: string;
  instructions: string;
  when: string;
  active: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

type Every = "day" | "weekday" | "week" | "hours";
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const field = "rounded border border-line bg-panel px-2 py-1 text-sm";

export function RoutineSettings() {
  const routines = useAction<Routine[]>("routine.list");
  const [title, setTitle] = createSignal("");
  const [instructions, setInstructions] = createSignal("");
  const [every, setEvery] = createSignal<Every>("weekday");
  const [at, setAt] = createSignal("07:00");
  const [day, setDay] = createSignal<(typeof DAYS)[number]>("mon");
  const [hours, setHours] = createSignal(4);

  async function add(e: Event) {
    e.preventDefault();
    const when = {
      every: every(),
      at: at(),
      ...(every() === "week" ? { day: day() } : {}),
      ...(every() === "hours" ? { hours: hours() } : {}),
    };
    const made = await act<Routine>("routine.create", {
      title: title(),
      instructions: instructions(),
      when,
    });
    if (made) {
      setTitle("");
      setInstructions("");
      toast.show(`"${made.title}" runs ${made.when}.`);
    }
  }

  return (
    <section class="space-y-2">
      <h2 class="font-semibold">Routines</h2>
      <p class="text-sm text-muted">
        Things Jarvis does for you on a schedule, browser and all. Anything that would send
        something still waits for your yes.
      </p>
      <ul class="space-y-1">
        <For each={routines.data ?? []}>
          {(r) => (
            <li class="space-y-1 rounded-md bg-sunk px-3 py-2 text-sm">
              <div class="flex items-center gap-3">
                <span class="font-medium">{r.title}</span>
                <Badge tone={r.active ? "ok" : "muted"}>{r.active ? r.when : "paused"}</Badge>
                <span class="flex-1 text-xs text-faint">
                  {r.lastRunAt ? `last ran ${ago(r.lastRunAt)}` : "hasn't run yet"}
                </span>
                <Button small onClick={() => void act("routine.run_now", { id: r.id })}>
                  Run now
                </Button>
                <Button
                  small
                  onClick={() => void act("routine.update", { id: r.id, active: !r.active })}
                >
                  {r.active ? "Turn off" : "Turn on"}
                </Button>
                <Button
                  small
                  kind="danger"
                  onClick={() => void act("routine.remove", { id: r.id })}
                >
                  Remove
                </Button>
              </div>
              <p class="whitespace-pre-wrap text-muted">{r.instructions}</p>
            </li>
          )}
        </For>
      </ul>
      <Show when={(routines.data ?? []).length === 0}>
        <p class="text-sm text-faint">No routines yet.</p>
      </Show>
      <form class="space-y-2" onSubmit={(e) => void add(e)}>
        <input
          class={`${field} w-full`}
          placeholder="Name, like School grades"
          aria-label="Routine name"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <textarea
          class={`${field} w-full`}
          rows={3}
          placeholder="What Jarvis should do, in your words"
          aria-label="What to do"
          value={instructions()}
          onInput={(e) => setInstructions(e.currentTarget.value)}
        />
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <select
            class={field}
            aria-label="How often"
            value={every()}
            onChange={(e) => setEvery(e.currentTarget.value as Every)}
          >
            <option value="day">Every day</option>
            <option value="weekday">Weekdays</option>
            <option value="week">Once a week</option>
            <option value="hours">Every few hours</option>
          </select>
          <Show when={every() === "week"}>
            <select
              class={field}
              aria-label="Day"
              value={day()}
              onChange={(e) => setDay(e.currentTarget.value as (typeof DAYS)[number])}
            >
              <For each={DAYS}>{(d) => <option value={d}>{d}</option>}</For>
            </select>
          </Show>
          <Show
            when={every() !== "hours"}
            fallback={
              <input
                class={`${field} w-16`}
                type="number"
                min="1"
                max="12"
                aria-label="Hours"
                value={hours()}
                onInput={(e) => setHours(Number(e.currentTarget.value) || 4)}
              />
            }
          >
            <span>at</span>
            <input
              class={field}
              type="time"
              aria-label="Time"
              value={at()}
              onInput={(e) => setAt(e.currentTarget.value)}
            />
          </Show>
          <Button kind="primary" onClick={(e) => void add(e)}>
            Add routine
          </Button>
        </div>
      </form>
    </section>
  );
}
