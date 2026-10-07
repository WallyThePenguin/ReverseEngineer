// Settings → Coming up: every reminder still to ring, however far ahead, each with Cancel. They're
// listed apart from Hearth's other schedules, which show only the next few.
import { For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { act, useAction } from "../lib/query.ts";
import { cancelQuestion, reminderLabel } from "../lib/reminders.ts";
import type { Reminder } from "../lib/types.ts";

export function ReminderSettings() {
  const reminders = useAction<Reminder[]>("reminder.list");
  const cancel = (r: Reminder) => {
    if (confirm(cancelQuestion(r))) void act("reminder.cancel", { id: r.id });
  };
  return (
    <Show when={(reminders.data ?? []).length > 0}>
      <h3 class="text-sm font-semibold">Reminders</h3>
      <ul class="space-y-1 text-sm">
        <For each={reminders.data}>
          {(r) => (
            <li class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="min-w-0 flex-1 basis-40 break-words">{reminderLabel(r)}</span>
              <span class="text-muted">{r.when}</span>
              <Button
                small
                kind="quiet"
                label={`Cancel the reminder for ${r.when}`}
                onClick={() => cancel(r)}
              >
                Cancel
              </Button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
