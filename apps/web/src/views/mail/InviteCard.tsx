// An invitation in a message, shown as the event on your calendar and answered right there.

import { createSignal, For, Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { Badge, Button } from "../../components/ui.tsx";
import { date, dateTime } from "../../lib/format.ts";
import { toast } from "../../lib/live.ts";
import { act } from "../../lib/query.ts";
import type { MailInvite } from "../../lib/types.ts";

const ANSWERS = [
  { response: "accepted", label: "Going" },
  { response: "tentative", label: "Maybe" },
  { response: "declined", label: "Not going" },
] as const;

/** An invitation, shown as the event on your calendar, answered right here. */
export function InviteCard(props: { invite: MailInvite }) {
  const ev = () => props.invite.event;
  const when = () => {
    const e = ev()!;
    const start = new Date(e.startsAt);
    return e.allDay ? date(start) : dateTime(start);
  };
  // A repeating meeting is answered for every time, unless you say this time only.
  const [scope, setScope] = createSignal<"all" | "this">("all");
  const answer = (response: string) =>
    void act("calendar.respond", {
      id: ev()!.id,
      response,
      ...(ev()!.recurring ? { scope: scope() } : {}),
    }).then((r) => r && toast.show("Answered. The organizer will see it."));
  return (
    <div class="flex items-start gap-2.5 rounded-md border border-line bg-sunk px-3 py-2 text-sm">
      <Icon name="calendar" size={18} class="mt-px text-muted" />
      <div class="min-w-0 flex-1">
        <Show
          when={props.invite.method !== "CANCEL"}
          fallback={
            <span>
              {props.invite.event?.cancelled
                ? `"${props.invite.event.title}" is cancelled on your calendar.`
                : "The sender says a meeting is cancelled. Your calendar doesn't show that."}
            </span>
          }
        >
          <Show when={ev()} fallback={<span>An invitation that isn't on your calendar yet.</span>}>
            {(e) => (
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{e().title}</span>
                <span class="text-muted">{when()}</span>
                <Show when={e().cancelled}>
                  <Badge tone="bad">cancelled</Badge>
                </Show>
                <span class="flex-1" />
                <Show when={!e().cancelled && !e().selfOrganizer}>
                  <Show when={e().recurring}>
                    <select
                      class="rounded-md border border-line bg-panel px-2 py-1 text-xs"
                      aria-label="Which times"
                      value={scope()}
                      onChange={(x) => setScope(x.currentTarget.value as "all" | "this")}
                    >
                      <option value="all">Every time</option>
                      <option value="this">This time only</option>
                    </select>
                  </Show>
                  <For each={ANSWERS}>
                    {(a) => (
                      <Button
                        small
                        kind={e().response === a.response ? "primary" : undefined}
                        onClick={() => answer(a.response)}
                      >
                        {a.label}
                      </Button>
                    )}
                  </For>
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
