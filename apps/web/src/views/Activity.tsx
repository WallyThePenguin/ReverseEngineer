// What Jarvis has been doing: every turn (what triggered it, what it did, how it ended), what
// it's watching for you, and what it noted for the next brief.

import { For, Show } from "solid-js";
import { NoRows } from "../components/QueryView.tsx";
import { Badge, Button, PaneHeader } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { Observation, Turn, Watch } from "../lib/types.ts";

const TRIGGER_LABEL: Record<string, string> = {
  chat: "You asked",
  mention: "@mentioned",
  assignment: "Assigned a task",
  thread: "Thread reply",
  approval: "After your approval",
  watch: "A watch matched",
  routine: "Routine",
  reflex: "Noticed something",
  heartbeat: "Heartbeat",
};

function outcomeTone(t: Turn): "ok" | "bad" | "jarvis" | "muted" {
  if (t.status === "failed") return "bad";
  if (t.status === "queued" || t.status === "running") return "jarvis";
  if (t.status === "skipped") return "muted";
  return "ok";
}

export function Activity() {
  const turns = useAction<Turn[]>("jarvis.activity", () => ({ limit: 100 }));
  const watches = useAction<Watch[]>("jarvis.watches");
  const notes = useAction<Observation[]>("observation.list", () => ({ limit: 50 }));

  const openTurn = (t: Turn, beside: boolean) => {
    if (t.conversationId) layout.open({ view: "chat", id: t.conversationId }, { beside });
    else if (t.subjectId) layout.open(routeFor("record", t.subjectId), { beside });
  };

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="What Jarvis did" sub="Everything Jarvis did, and why" />
      <div class="flex-1 space-y-6 overflow-auto px-4 py-4">
        <Show when={(watches.data ?? []).length > 0}>
          <section>
            <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
              Watching for you
            </h3>
            <ul class="space-y-1">
              <For each={watches.data}>
                {(w) => (
                  <li class="flex items-center gap-3 rounded-md bg-sunk px-3 py-2">
                    <span class="flex-1">{w.description}</span>
                    <Show when={w.expiresAt}>
                      <span class="text-xs text-faint">
                        until {new Date(w.expiresAt!).toLocaleDateString()}
                      </span>
                    </Show>
                    <Button small onClick={() => void act("jarvis.unwatch", { id: w.id })}>
                      Stop
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={(notes.data ?? []).length > 0}>
          <section>
            <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
              Noted for your next brief
            </h3>
            <ul class="space-y-1 text-sm">
              <For each={notes.data}>
                {(o) => (
                  <li class="flex gap-2">
                    <Badge tone={o.kind === "risk" ? "warn" : "muted"}>{o.kind}</Badge>
                    <span>{o.text}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <section>
          <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-faint">Turns</h3>
          <Show
            when={(turns.data ?? []).length > 0}
            fallback={
              <NoRows query={turns} what="Jarvis's activity">
                Jarvis hasn't done anything yet.
              </NoRows>
            }
          >
            <ul class="divide-y divide-line">
              <For each={turns.data}>
                {(t) => (
                  <li class="cursor-pointer py-2.5" onClick={(e) => openTurn(t, e.shiftKey)}>
                    <div class="flex items-center gap-2 text-sm">
                      <span class="font-medium">{TRIGGER_LABEL[t.trigger] ?? t.trigger}</span>
                      <Show when={t.mode === "proactive"}>
                        <Badge tone="jarvis">On its own</Badge>
                      </Show>
                      <Badge tone={outcomeTone(t)}>
                        {t.status === "done" ? (t.outcome ?? "done") : t.status}
                      </Badge>
                      <span class="flex-1" />
                      <span class="text-xs text-faint">{ago(t.queuedAt)}</span>
                    </div>
                    <p class="mt-0.5 line-clamp-2 text-sm text-muted">
                      {t.reply ?? t.skipReason ?? t.error ?? t.prompt}
                    </p>
                    <Show when={t.toolsUsed.length > 0}>
                      <p class="mt-0.5 text-xs text-faint">
                        Used {[...new Set(t.toolsUsed)].join(", ")}
                      </p>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </div>
    </div>
  );
}
