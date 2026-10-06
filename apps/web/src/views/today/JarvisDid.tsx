// Today's "What Jarvis did": its turns since yesterday that came to something, each as the first
// line of what it said and what it used, in plain words. A turn that read outside content on its
// way, or started from some, is marked, since its words may carry someone else's (D58).

import { For, Show } from "solid-js";
import { Pill } from "../../components/kit/Pill.tsx";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { day, time } from "../../lib/format.ts";
import { routeFor } from "../../lib/panes.ts";
import { readOutside, replyLine, toolsSaid } from "../../lib/today.ts";
import type { Turn } from "../../lib/types.ts";
import { CardEmpty, CardWaiting, type Go, TodayCard, TodayRow } from "./parts.tsx";

/** How many turns the card shows; the rest are in Jarvis's activity. */
const SHOWN = 6;

export function JarvisDid(props: {
  query: QueryRead<unknown>;
  turns: readonly Turn[];
  now: Date;
  go: Go;
}) {
  const open = (t: Turn, beside: boolean) => {
    if (t.conversationId) props.go({ view: "chat", id: t.conversationId }, beside);
    else if (t.subjectId) props.go(routeFor("record", t.subjectId), beside);
    else props.go({ view: "activity" }, beside);
  };
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
      count={props.turns.length}
      more={{ run: () => props.go({ view: "activity" }) }}
    >
      <Show
        when={props.query.data !== undefined}
        fallback={<CardWaiting query={props.query} what="Jarvis's activity" />}
      >
        <Show
          when={props.turns.length > 0}
          fallback={<CardEmpty>Nothing since yesterday. What Jarvis does shows up here.</CardEmpty>}
        >
          <ul>
            <For each={props.turns.slice(0, SHOWN)}>
              {(t) => {
                const tools = () => toolsSaid(t.toolsUsed).join(" · ");
                const outside = () => readOutside(t);
                return (
                  <TodayRow
                    title={<span class="line-clamp-2">{replyLine(t)}</span>}
                    meta={tools() || undefined}
                    end={<span class="text-meta text-muted tabular-nums">{when(t.queuedAt)}</span>}
                    onOpen={(beside) => open(t, beside)}
                    below={
                      outside() || t.status === "failed" ? (
                        <div class="flex flex-wrap gap-1.5">
                          <Show when={outside()}>
                            <OutsideMark>Read outside content</OutsideMark>
                          </Show>
                          <Show when={t.status === "failed"}>
                            <Pill tone="bad">Didn't finish</Pill>
                          </Show>
                        </div>
                      ) : undefined
                    }
                  />
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </TodayCard>
  );
}
