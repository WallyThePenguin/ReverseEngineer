// Jarvis's conversations with people in your Slack (D62), on Activity's Slack filter: each
// member's DM and each channel thread it answered in. Opening one shows it read-only, under the
// bar you act from (jarvis/SlackBar.tsx).

import { For, Show } from "solid-js";
import { Badge } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import { pausedNow, placeOf, type SlackConversation } from "../lib/slack.ts";

export function SlackConversations() {
  const list = useAction<SlackConversation[]>("slack.conversations", () => ({ limit: 50 }));
  return (
    <section>
      <h3 class="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
        Conversations in Slack
      </h3>
      <Show
        when={(list.data ?? []).length > 0}
        fallback={<p class="text-sm text-muted">Nobody in your Slack has talked to Jarvis yet.</p>}
      >
        <ul class="divide-y divide-line">
          <For each={list.data}>
            {(c) => (
              <li
                class="flex cursor-pointer items-center gap-2 py-2 text-sm"
                onClick={(e) => layout.open({ view: "chat", id: c.id }, { beside: e.shiftKey })}
              >
                <span class="flex-1 font-medium">{placeOf(c)}</span>
                <Show when={pausedNow(c)}>
                  <Badge tone="warn">Paused</Badge>
                </Show>
                <Show when={c.heldReplies > 0}>
                  <Badge tone="jarvis">Needs your yes</Badge>
                </Show>
                <Show when={c.waiting > 0}>
                  <Badge>{`${c.waiting} waiting`}</Badge>
                </Show>
                <Show when={c.lastAt}>
                  {(at) => <span class="text-xs text-faint">{ago(at())}</span>}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
