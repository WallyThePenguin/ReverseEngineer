// One inbox row: Jarvis's result, a due date or an alert, or an approval, which is a card that
// shows its text in full and waits for your yes or no (D58). The inbox's keys work on the row
// the keyboard is on; the "more" menu does what e and s do, for a finger.

import { For, Show } from "solid-js";
import { ApprovalCard } from "../../components/ApprovalCard.tsx";
import { Body } from "../../components/Body.tsx";
import { Overflow, ROW_MENU } from "../../components/Menu.tsx";
import { Badge, Button, Kbd } from "../../components/ui.tsx";
import { ago, due, snoozeOptions, who } from "../../lib/format.ts";
import { approvalParts, type InboxView, rowMenu } from "../../lib/inbox.ts";
import type { InboxRow } from "../../lib/types.ts";

export function InboxItem(props: {
  row: InboxRow;
  view: InboxView;
  /** The row the keyboard is on. */
  active: boolean;
  /** Its snooze choices are showing (s, or Snooze… from its menu). */
  snoozing: boolean;
  /** Opens what it's about; `beside` when Shift was held. */
  onOpen: (beside: boolean) => void;
  onDone: () => void;
  onSnooze: () => void;
  onSnoozeUntil: (until: Date) => void;
}) {
  const n = () => props.row.notification;
  const deadline = () => due(n().deadline, false);
  return (
    <li
      class="group cursor-pointer border-b border-line py-3 pr-2 pl-4"
      data-active={props.active}
      onClick={(e) => props.onOpen(e.shiftKey)}
    >
      <div class="flex items-start gap-3">
        <span
          class={`mt-1.5 size-2 shrink-0 rounded-full ${n().state === "unseen" ? "bg-accent" : "bg-transparent"}`}
        />
        <div class="min-w-0 flex-1">
          <Show
            when={n().approvalId}
            fallback={
              <>
                <div class="flex items-center gap-2">
                  <span class={`truncate ${n().state === "unseen" ? "font-semibold" : ""}`}>
                    {n().title}
                  </span>
                  <Show when={n().urgency === "interrupt"}>
                    <Badge tone="bad">Urgent</Badge>
                  </Show>
                  <Show when={n().kind === "brief"}>
                    <Badge tone="jarvis">Brief</Badge>
                  </Show>
                </div>
                <Show when={n().body && n().kind !== "brief"}>
                  <div class="mt-0.5 line-clamp-3 text-sm text-muted">
                    <Body text={n().body} />
                  </div>
                </Show>
              </>
            }
          >
            {(approvalId) => {
              const parts = () => approvalParts(n());
              return (
                <ApprovalCard
                  approvalId={approvalId()}
                  what={parts().what}
                  why={parts().why}
                  text={parts().text}
                  status={props.row.approvalStatus}
                  byJarvis={n().createdBy === "jarvis"}
                  meta={
                    <>
                      {ago(n().createdAt)}
                      <Show when={deadline()}>
                        {(d) => (
                          <span class={d().overdue ? "text-bad" : "text-warn"}>
                            {` · due ${d().text}`}
                          </span>
                        )}
                      </Show>
                    </>
                  }
                  keys
                />
              );
            }}
          </Show>
          <Show when={props.snoozing}>
            <div class="mt-2 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
              <For each={snoozeOptions()}>
                {(o, j) => (
                  <Button small onClick={() => props.onSnoozeUntil(o.until)}>
                    <Kbd>{j() + 1}</Kbd> {o.label}
                  </Button>
                )}
              </For>
            </div>
          </Show>
        </div>
        {/* An approval's card says when it was asked, and its title who asks: on a phone the card
            needs the width. */}
        <Show when={!n().approvalId}>
          <div class="shrink-0 text-right text-xs text-faint">
            <div>{ago(n().createdAt)}</div>
            <Show when={n().createdBy !== "owner"}>
              <div>{who(n().createdBy)}</div>
            </Show>
            <Show when={deadline()}>
              {(d) => <div class={d().overdue ? "text-bad" : "text-warn"}>due {d().text}</div>}
            </Show>
          </div>
        </Show>
        {/* What e and s do, for a finger. */}
        <Overflow
          class={ROW_MENU}
          label={`Actions for ${n().title}`}
          items={rowMenu(props.row, props.view, { done: props.onDone, snooze: props.onSnooze })}
        />
      </div>
    </li>
  );
}
