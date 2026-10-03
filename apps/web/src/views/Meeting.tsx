// A meeting's page: your notes as you go, then Jarvis's summary and the tasks that came out of it,
// with the event, the people and the transcript.

import { createSignal, For, Show } from "solid-js";
import { Body } from "../components/Body.tsx";
import { Button } from "../components/ui.tsx";
import { day } from "../lib/format.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";

interface MeetingDetail {
  id: string;
  title: string;
  notes: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  event: { id: string; title: string; startsAt: string } | null;
  people: { id: string; name: string }[];
  tasks: { id: string; title: string; number: number; status: string }[];
  segments: { id: string; channel: "me" | "them"; startMs: number; text: string }[];
}

const stamp = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Starts (or opens) the notes for a calendar event. */
export async function takeNotes(eventId: string, beside = false) {
  const m = await act<{ id: string }>("meeting.start", { eventId });
  if (m) layout.open(routeFor("meeting", m.id), { beside });
}

export function MeetingPanel(props: { id: string }) {
  // While it's going, the desktop recorder adds to the transcript every few seconds.
  const m = useAction<MeetingDetail>(
    "meeting.get",
    () => ({ id: props.id, segments: true }),
    undefined,
    (d) => (d && !d.endedAt ? 4000 : false),
  );
  const [opened, setShowTranscript] = createSignal<boolean | null>(null);
  const showTranscript = () => opened() ?? !m.data?.endedAt;
  const open = (type: string, id: string, e: MouseEvent) =>
    layout.open(routeFor(type, id), { beside: e.shiftKey });
  return (
    <Show when={m.data}>
      {(v) => (
        <div class="space-y-5">
          <Show when={!v().endedAt && v().segments.length > 0}>
            <p class="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
              ● Recording. The transcript fills in as people talk; stop from the desktop app's tray
              menu.
            </p>
          </Show>
          <div class="space-y-1 rounded-md bg-sunk px-3 py-3 text-sm">
            <Show when={v().event}>
              {(ev) => (
                <p>
                  <button
                    type="button"
                    class="text-jarvis underline"
                    onClick={(e) => open("event", ev().id, e)}
                  >
                    {ev().title}
                  </button>{" "}
                  <span class="text-muted">{day(new Date(ev().startsAt))}</span>
                </p>
              )}
            </Show>
            <Show when={v().people.length > 0}>
              <p class="text-muted">
                With{" "}
                <For each={v().people}>
                  {(p, i) => (
                    <>
                      {i() > 0 ? ", " : ""}
                      <button
                        type="button"
                        class="underline"
                        onClick={(e) => open("person", p.id, e)}
                      >
                        {p.name}
                      </button>
                    </>
                  )}
                </For>
              </p>
            </Show>
            <Show when={!v().endedAt}>
              <p class="flex items-center gap-3 pt-1">
                <Button small kind="jarvis" onClick={() => void act("meeting.end", { id: v().id })}>
                  End and summarize
                </Button>
                <span class="text-xs text-faint">
                  Recording a call? Let everyone know you're taking notes.
                </span>
              </p>
            </Show>
          </div>

          <div>
            <h3 class="mb-1 text-xs font-medium uppercase tracking-wide text-faint">Your notes</h3>
            <textarea
              class="min-h-32 w-full resize-y rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none"
              placeholder="What matters in this meeting…"
              value={v().notes}
              onBlur={(e) => {
                const notes = e.currentTarget.value;
                if (notes !== v().notes) void act("meeting.update", { id: v().id, notes });
              }}
            />
          </div>

          <Show
            when={v().summary}
            fallback={
              <Show when={v().endedAt}>
                <p class="text-sm text-muted">Jarvis is writing the summary…</p>
              </Show>
            }
          >
            {(s) => (
              <div>
                <h3 class="mb-1 text-xs font-medium uppercase tracking-wide text-faint">Summary</h3>
                <Body text={s()} />
              </div>
            )}
          </Show>

          <Show when={v().tasks.length > 0}>
            <div>
              <h3 class="mb-1 text-xs font-medium uppercase tracking-wide text-faint">Tasks</h3>
              <ul class="space-y-0.5 text-sm">
                <For each={v().tasks}>
                  {(t) => (
                    <li>
                      <button
                        type="button"
                        class="flex w-full gap-2 rounded px-2 py-1 text-left hover:bg-sunk"
                        onClick={(e) => open("task", t.id, e)}
                      >
                        <span class="text-faint">T-{t.number}</span>
                        <span class="truncate">{t.title}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>

          <Show when={v().segments.length > 0}>
            <div>
              <button
                type="button"
                class="text-xs font-medium uppercase tracking-wide text-faint"
                onClick={() => setShowTranscript(!showTranscript())}
              >
                Transcript ({v().segments.length}) {showTranscript() ? "▾" : "▸"}
              </button>
              <Show when={showTranscript()}>
                <ul class="mt-1 space-y-1 text-sm">
                  <For each={v().segments}>
                    {(s) => (
                      <li class="flex gap-2">
                        <span class="w-10 shrink-0 text-xs text-faint">{stamp(s.startMs)}</span>
                        <span class={s.channel === "me" ? "font-medium" : "text-muted"}>
                          {s.channel === "me" ? "You" : "Them"}:
                        </span>
                        <span class="flex-1">{s.text}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
