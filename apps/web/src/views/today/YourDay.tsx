// Today's "Your day": today's meetings in time order, the one on now and the next one marked, with
// Join where there's a video call; any you haven't answered are answered right on their row, and
// the invitations after today that still wait for your answer follow.

import { For, Show } from "solid-js";
import { InviteAnswers } from "../../components/InviteAnswers.tsx";
import { Icon } from "../../components/icons.tsx";
import { Pill } from "../../components/kit/Pill.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { day, plural, time } from "../../lib/format.ts";
import { layout } from "../../lib/panes.ts";
import { meetingState, nextMeeting, unanswered } from "../../lib/today.ts";
import type { CalEvent } from "../../lib/types.ts";
import { CardEmpty, CardWaiting, TodayCard, TodayRow } from "./parts.tsx";

export function YourDay(props: {
  query: QueryRead<unknown>;
  today: readonly CalEvent[];
  invites: readonly CalEvent[];
  now: Date;
}) {
  const next = () => nextMeeting(props.today, props.now);
  return (
    <TodayCard
      product="calendar"
      icon="calendar"
      title="Your day"
      count={props.today.length}
      more={{ run: () => layout.open({ view: "calendar" }) }}
    >
      <Show
        when={props.query.data !== undefined}
        fallback={<CardWaiting query={props.query} what="your calendar" />}
      >
        <Show
          when={props.today.length > 0}
          fallback={<CardEmpty>Nothing on your calendar today.</CardEmpty>}
        >
          <ul>
            <For each={props.today}>
              {(e) => (
                <Meeting e={e} state={meetingState(e, next(), e.id, props.now)} now={props.now} />
              )}
            </For>
          </ul>
        </Show>
        <Show when={props.invites.length > 0}>
          <h3 class="border-t border-line px-4 pt-3 pb-1 text-meta font-medium text-muted">
            Waiting for your answer
          </h3>
          <ul>
            <For each={props.invites}>
              {(e) => <Meeting e={e} state="later" now={props.now} showDay />}
            </For>
          </ul>
        </Show>
      </Show>
    </TodayCard>
  );
}

function Meeting(props: {
  e: CalEvent;
  state: "past" | "now" | "next" | "later";
  now: Date;
  /** For a meeting on another day: its day over its time. */
  showDay?: boolean;
}) {
  const e = () => props.e;
  const start = () => new Date(e().startsAt);
  const guests = () => e().attendees.filter((a) => !a.self).length;
  const meta = () =>
    [e().location, guests() ? plural(guests(), "guest") : null].filter(Boolean).join(" · ");
  const soon = () => {
    const mins = Math.round((start().getTime() - props.now.getTime()) / 60_000);
    return mins > 0 && mins <= 60 ? `In ${mins} min` : "Next";
  };
  // Join stands out for the meeting on now and the next one.
  const joinLook = () =>
    props.state === "now" || props.state === "next"
      ? "bg-accent text-on-fill"
      : "border border-line bg-panel hover:bg-sunk";
  return (
    <TodayRow
      quiet={props.state === "past"}
      lead={
        <span class="w-16 text-meta text-muted tabular-nums">
          <Show when={props.showDay}>
            <span class="block font-medium text-ink capitalize">{day(start(), props.now)}</span>
          </Show>
          {e().allDay ? "All day" : time(start())}
        </span>
      }
      title={e().title}
      meta={meta() || undefined}
      end={
        <>
          <Show when={props.state === "now"}>
            <Pill tone="accent">Now</Pill>
          </Show>
          <Show when={props.state === "next"}>
            <Pill>{soon()}</Pill>
          </Show>
          <Show when={e().meetUrl && props.state !== "past"}>
            <a
              href={e().meetUrl!}
              target="_blank"
              rel="noreferrer"
              class={`-my-1 inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm font-medium md:min-h-0 md:px-2 md:py-0.5 md:text-xs ${joinLook()}`}
              onClick={(ev) => ev.stopPropagation()}
            >
              <Icon name="video" size={14} />
              Join
            </a>
          </Show>
        </>
      }
      onOpen={() => layout.open({ view: "record", id: e().id }, { beside: true })}
      below={
        unanswered(e()) ? (
          <InviteAnswers
            eventId={e().id}
            response={e().selfResponse}
            recurring={e().recurringEventId !== null}
          />
        ) : undefined
      }
    />
  );
}
