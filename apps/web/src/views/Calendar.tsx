// Your calendar as a list: the next week, day by day, with focus blocks and answers marked.

import { createSignal, For, Show } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { Badge, Button, Empty, PaneHeader } from "../components/ui.tsx";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import type { CalEvent } from "../lib/types.ts";
import { takeNotes } from "./Meeting.tsx";

const DAY_MS = 24 * 3600_000;
const dayLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** The tick or cross after the name of someone who has answered an invitation. */
const ANSWERED = "ml-0.5 inline align-[-2px]";

export function Calendar(props: { pane: number }) {
  const [offset, setOffset] = createSignal(0);
  const from = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return new Date(d.getTime() + offset() * 7 * DAY_MS);
  };
  const events = useAction<CalEvent[]>("calendar.events", () => ({
    from: from().toISOString(),
    to: new Date(from().getTime() + 7 * DAY_MS).toISOString(),
  }));
  const days = () => {
    const groups = new Map<string, CalEvent[]>();
    for (const e of events.data ?? []) {
      const start = new Date(e.startsAt);
      const key = (start < from() ? from() : start).toDateString();
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return [...groups.entries()];
  };
  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Calendar">
        <div class="flex gap-1">
          <Button small onClick={() => setOffset(offset() - 1)}>
            Earlier
          </Button>
          <Button small onClick={() => setOffset(0)}>
            This week
          </Button>
          <Button small onClick={() => setOffset(offset() + 1)}>
            Later
          </Button>
        </div>
      </PaneHeader>
      <div class="flex-1 overflow-auto">
        <Show
          when={days().length > 0}
          fallback={
            <Empty>
              Nothing on your calendar this week, or Google isn't connected yet (Settings).
            </Empty>
          }
        >
          <For each={days()}>
            {([day, list]) => (
              <section>
                <h2 class="sticky top-0 bg-panel px-4 pt-3 pb-1 text-xs font-semibold text-muted uppercase">
                  {dayLabel(new Date(day))}
                </h2>
                <ul>
                  <For each={list}>
                    {(e) => (
                      <li
                        class="flex cursor-pointer items-baseline gap-3 border-b border-line px-4 py-2"
                        onClick={() =>
                          layout.open(
                            { view: "record", id: e.id },
                            { beside: true, pane: props.pane },
                          )
                        }
                      >
                        <span class="w-20 shrink-0 text-xs text-muted">
                          {e.allDay ? "all day" : time(new Date(e.startsAt))}
                        </span>
                        <span
                          class={`flex-1 truncate ${e.selfResponse === "declined" ? "line-through opacity-60" : ""}`}
                        >
                          {e.title}
                        </span>
                        <Show when={e.taskId}>
                          <Badge tone="jarvis">focus</Badge>
                        </Show>
                        <Show when={e.selfResponse === "needsAction"}>
                          <Badge tone="warn">not answered</Badge>
                        </Show>
                        <Show when={e.attendees.filter((a) => !a.self).length > 0}>
                          <span class="text-xs text-faint">
                            {e.attendees.filter((a) => !a.self).length} guests
                          </span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

/** An event's own part of its record: when, where, who, and a link to it in Google. */
export function EventPanel(props: { id: string }) {
  const ev = useAction<CalEvent | null>("calendar.get", () => ({ id: props.id }));
  return (
    <Show when={ev.data}>
      {(e) => (
        <div class="space-y-1 rounded-md bg-sunk px-3 py-3 text-sm">
          <p class="font-medium">
            {e().allDay
              ? `${dayLabel(new Date(e().startsAt))}, all day`
              : `${dayLabel(new Date(e().startsAt))}, ${time(new Date(e().startsAt))} to ${time(new Date(e().endsAt))}`}
            {e().status === "cancelled" ? " (cancelled)" : ""}
          </p>
          <Show when={e().location}>
            <p class="text-muted">{e().location}</p>
          </Show>
          <Show when={e().attendees.filter((a) => !a.self).length > 0}>
            <p class="text-muted">
              With{" "}
              <For each={e().attendees.filter((a) => !a.self)}>
                {(a, i) => (
                  <>
                    {i() > 0 ? ", " : ""}
                    {a.name ?? a.email}
                    <Show when={a.response === "accepted"}>
                      <Icon name="check" size={14} label="(going)" class={`${ANSWERED} text-ok`} />
                    </Show>
                    <Show when={a.response === "declined"}>
                      <Icon name="x" size={14} label="(not going)" class={`${ANSWERED} text-bad`} />
                    </Show>
                  </>
                )}
              </For>
            </p>
          </Show>
          <p class="flex gap-3 pt-1">
            <button
              type="button"
              class="text-jarvis underline"
              onClick={(ev) => void takeNotes(e().id, ev.shiftKey)}
            >
              Meeting notes
            </button>
            <Show when={e().meetUrl}>
              <a
                class="text-jarvis underline"
                href={e().meetUrl ?? ""}
                target="_blank"
                rel="noreferrer"
              >
                Join video call
              </a>
            </Show>
            <Show when={e().htmlLink}>
              <a
                class="text-jarvis underline"
                href={e().htmlLink ?? ""}
                target="_blank"
                rel="noreferrer"
              >
                Open in Google Calendar
              </a>
            </Show>
          </p>
        </div>
      )}
    </Show>
  );
}
