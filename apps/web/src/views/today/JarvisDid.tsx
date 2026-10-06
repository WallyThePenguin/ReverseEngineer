// Today's "What Jarvis did": what it made since yesterday, one line each (a drafted reply, a task,
// a meeting's prep, the brief), read from the records themselves (jarvis.did), so a line is never
// Jarvis's own claim about what it did. Each opens what it made, and one written after reading
// outside content says so (D58). Runs that stopped before they finished are counted under them, so
// a failure never goes quiet.

import { For, Show } from "solid-js";
import { Icon, type IconName } from "../../components/icons.tsx";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { day, plural, time } from "../../lib/format.ts";
import type { PaneRoute } from "../../lib/panes.ts";
import type { Did } from "../../lib/types.ts";
import { CardEmpty, CardWaiting, type Go, TodayCard, TodayRow } from "./parts.tsx";

/** How many the card shows; the rest are in Jarvis's activity. */
const SHOWN = 6;

/** Each kind of thing Jarvis makes, by the icon of where it lives. */
const KIND: Record<string, IconName> = {
  email_draft: "mail",
  task: "tasks",
  event: "calendar",
  prep: "calendar",
  brief: "today",
  journal: "docs",
  note: "docs",
};

export function JarvisDid(props: {
  query: QueryRead<unknown>;
  items: readonly Did[];
  /** Runs since yesterday that stopped before they finished. */
  failed: number;
  now: Date;
  go: Go;
  /** Where each opens: a drafted reply in its conversation, anything else as itself. */
  routeOf: (d: Did) => PaneRoute;
}) {
  const when = (iso: string) => {
    const d = new Date(iso);
    const on = day(d, props.now);
    return on === "today" ? time(d) : on === "yesterday" ? "Yesterday" : on;
  };
  return (
    <TodayCard
      product="jarvis"
      icon="mark"
      title="What Jarvis did"
      count={props.items.length}
      more={{ run: () => props.go({ view: "activity" }) }}
    >
      <Show
        when={props.query.data !== undefined}
        fallback={<CardWaiting query={props.query} what="what Jarvis did" />}
      >
        <Show
          when={props.items.length > 0 || props.failed > 0}
          fallback={
            <CardEmpty>Nothing since yesterday. What Jarvis makes for you shows up here.</CardEmpty>
          }
        >
          <ul>
            <For each={props.items.slice(0, SHOWN)}>
              {(d) => (
                <TodayRow
                  lead={<Icon name={KIND[d.entityType] ?? "docs"} class="text-muted" />}
                  title={<span class="line-clamp-2">{d.text}</span>}
                  meta={d.outside ? <OutsideMark>Read outside content</OutsideMark> : undefined}
                  end={<span class="text-meta text-muted tabular-nums">{when(d.at)}</span>}
                  onOpen={(beside) => props.go(props.routeOf(d), beside)}
                />
              )}
            </For>
            <Show when={props.failed > 0}>
              <TodayRow
                lead={<Icon name="bad" class="text-bad" />}
                title={`${plural(props.failed, "run")} didn't finish`}
                meta="See what happened"
                onOpen={(beside) => props.go({ view: "activity" }, beside)}
              />
            </Show>
          </ul>
        </Show>
      </Show>
    </TodayCard>
  );
}
