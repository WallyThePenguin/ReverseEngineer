// Today's "Your day": today's meetings in time order, the one on now and the next one marked, with
// Join where there's a video call; any you haven't answered are answered right on their row, and
// the invitations after today that still wait for your answer follow. Where Today is one column
// (a phone), the meeting on now or next also sits under the greeting, Join and all, so it isn't
// screens away below what needs you.

import { For, Show } from "solid-js";
import { InviteAnswers } from "../../components/InviteAnswers.tsx";
import { Icon } from "../../components/icons.tsx";
import { Pill } from "../../components/kit/Pill.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { day, plural, time } from "../../lib/format.ts";
import { meetingState, nextMeeting, unanswered } from "../../lib/today.ts";
import type { CalEvent } from "../../lib/types.ts";
import { CardEmpty, CardWaiting, type Go, TodayCard, TodayRow } from "./parts.tsx";

export function YourDay(props: {
  query: QueryRead<unknown>;
  today: readonly CalEvent[];
  invites: readonly CalEvent[];
  now: Date;
  go: Go;
}) {
  const next = () => nextMeeting(props.today, props.now);
  return (
    <TodayCard
      product="calendar"
      icon="calendar"
      title="Your day"
      count={props.today.length}
      more={{ run: () => props.go({ view: "calendar" }) }}
      jump="today-day"
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
                <Meeting
                  e={e}
                  state={meetingState(e, next(), e.id, props.now)}
                  now={props.now}
                  go={props.go}
                />
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
              {(e) => <Meeting e={e} state="later" now={props.now} go={props.go} showDay />}
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
  go: Go;
  /** For a meeting on another day: its day over its time. */
  showDay?: boolean;
}) {
  const e = () => props.e;
  const start = () => new Date(e().startsAt);
  const guests = () => e().attendees.filter((a) => !a.self).length;
  const meta = () =>
    [e().location, guests() ? plural(guests(), "guest") : null].filter(Boolean).join(" · ");
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
            <Pill>{soon(e(), props.now)}</Pill>
          </Show>
          <Show when={e().meetUrl && props.state !== "past"}>
            <Join url={e().meetUrl!} strong={props.state === "now" || props.state === "next"} />
          </Show>
        </>
      }
      onOpen={(beside) => props.go({ view: "record", id: e().id }, beside)}
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

/** "In 25 min" for a meeting within the hour, otherwise "Next". */
function soon(e: CalEvent, now: Date): string {
  const mins = Math.round((Date.parse(e.startsAt) - now.getTime()) / 60_000);
  return mins > 0 && mins <= 60 ? `In ${mins} min` : "Next";
}

/** A video call's Join; it stands out for the meeting on now and the next one. */
function Join(props: { url: string; strong: boolean }) {
  return (
    <a
      href={props.url}
      target="_blank"
      rel="noreferrer"
      class={`-my-1 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium md:min-h-0 md:px-2 md:py-0.5 md:text-xs ${props.strong ? "bg-accent text-on-fill" : "border border-line bg-panel hover:bg-sunk"}`}
      onClick={(ev) => ev.stopPropagation()}
    >
      <Icon name="video" size={14} />
      Join
    </a>
  );
}

/**
 * The meeting on now, or else today's next one, in a line under the greeting where Today is one
 * column: its time, its name and Join. Nothing when the day's meetings are over.
 */
export function UpNext(props: { today: readonly CalEvent[]; now: Date; go: Go; class?: string }) {
  const meeting = () => {
    const at = props.now.getTime();
    const ahead = props.today.filter((e) => !e.allDay && Date.parse(e.endsAt) > at);
    const e =
      ahead.find((m) => Date.parse(m.startsAt) <= at) ??
      ahead.find((m) => Date.parse(m.startsAt) > at);
    return e ? { e, now: Date.parse(e.startsAt) <= at } : undefined;
  };
  return (
    <Show when={meeting()}>
      {(m) => (
        <div
          data-product="calendar"
          class={`flex min-h-12 items-center gap-2.5 rounded-lg border border-line bg-panel py-1.5 pr-1.5 pl-3 ${props.class ?? ""}`}
        >
          <Icon name="calendar" class="shrink-0 text-hue" />
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-sm"
            onClick={(ev) => props.go({ view: "record", id: m().e.id }, ev.shiftKey)}
          >
            <span class={`font-medium ${m().now ? "text-accent" : ""}`}>
              {m().now ? "Now" : `${soon(m().e, props.now)} · ${time(new Date(m().e.startsAt))}`}
            </span>
            <span class="text-muted"> · </span>
            {m().e.title}
          </button>
          <Show when={m().e.meetUrl}>{(url) => <Join url={url()} strong />}</Show>
        </div>
      )}
    </Show>
  );
}
