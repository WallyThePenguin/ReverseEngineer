// An invitation in a message, shown as the event on your calendar and answered right there.

import { Show } from "solid-js";
import { InviteAnswers } from "../../components/InviteAnswers.tsx";
import { Icon } from "../../components/icons.tsx";
import { Badge } from "../../components/ui.tsx";
import { date, dateTime } from "../../lib/format.ts";
import type { MailInvite } from "../../lib/types.ts";

/** An invitation, shown as the event on your calendar, answered right here. */
export function InviteCard(props: { invite: MailInvite }) {
  const ev = () => props.invite.event;
  const when = () => {
    const e = ev()!;
    const start = new Date(e.startsAt);
    return e.allDay ? date(start) : dateTime(start);
  };
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
                  <InviteAnswers
                    eventId={e().id}
                    response={e().response}
                    recurring={e().recurring}
                  />
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
