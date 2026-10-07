// One inbox row: Jarvis's result, a due date or an alert, or an approval, which is a card that
// shows its text in full and waits for your yes or no (D58). The inbox's keys work on the row
// the keyboard is on; the "more" menu does what e and s do, for a finger.

import { For, Show } from "solid-js";
import { ApprovalCard } from "../../components/ApprovalCard.tsx";
import { Body } from "../../components/Body.tsx";
import { Overflow, ROW_MENU } from "../../components/Menu.tsx";
import { Badge, Button, Kbd } from "../../components/ui.tsx";
import { ago, due, snoozeOptions, who } from "../../lib/format.ts";
import { approvalParts, type InboxView, rowMenu, wholeBody } from "../../lib/inbox.ts";
import type { InboxRow } from "../../lib/types.ts";

export function InboxItem(props: {
  row: InboxRow;
  view: InboxView;
  /** The row the keyboard is on. */
  active: boolean;
  /** Its snooze choices are showing (s, or Snooze… from its menu). */
  snoozing: boolean;
  /** Makes it the row the keyboard is on. */
  onSelect: () => void;
  /** Opens what it's about; `beside` when Shift was held. */
  onOpen: (beside: boolean) => void;
  onDone: () => void;
  onSnooze: () => void;
  onSnoozeUntil: (until: Date) => void;
}) {
  const n = () => props.row.notification;
  const deadline = () => due(n().deadline, false);
  // What e and s do, for a finger.
  const menu = () => (
    <Overflow
      class={ROW_MENU}
      label={`Actions for ${n().title}`}
      items={rowMenu(props.row, props.view, { done: props.onDone, snooze: props.onSnooze })}
    />
  );
  const snoozes = () => (
    <Show when={props.snoozing}>
      <div class="mt-2 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
        {/* Kept by their words, which change with the hour, not the minute ("In 3 hours" until
            moves on each minute), so the focus stays; the time is read as it's chosen. */}
        <For each={snoozeOptions().map((o) => o.label)}>
          {(label, j) => (
            <Button
              small
              onClick={() => {
                const o = snoozeOptions().find((x) => x.label === label);
                if (o) props.onSnoozeUntil(o.until);
              }}
            >
              <Kbd hint>{j() + 1}</Kbd> {label}
            </Button>
          )}
        </For>
      </div>
    </Show>
  );
  return (
    <li
      class={`group cursor-pointer border-b border-line ${n().approvalId ? "px-3 py-2 md:px-4 md:py-3" : "py-3 pr-2 pl-4"}`}
      data-active={props.active}
      // Focus inside a row (its text box, a button, its menu) puts the keyboard on it, so a and
      // d decide the card you're in, not one you moved away from.
      onFocusIn={() => props.onSelect()}
      onClick={(e) => props.onOpen(e.shiftKey)}
    >
      <Show
        when={n().approvalId}
        fallback={
          <div class="flex items-start gap-3">
            <span
              class={`mt-1.5 size-2 shrink-0 rounded-full ${n().state === "unseen" ? "bg-accent" : "bg-transparent"}`}
            />
            <div class="min-w-0 flex-1">
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
                <div class={`mt-0.5 text-sm text-muted ${wholeBody(n()) ? "" : "line-clamp-3"}`}>
                  <Body text={n().body} />
                </div>
              </Show>
              {snoozes()}
            </div>
            <div class="shrink-0 text-right text-xs text-faint">
              <div>{ago(n().createdAt)}</div>
              <Show when={n().createdBy !== "owner"}>
                <div>{who(n().createdBy)}</div>
              </Show>
              <Show when={deadline()}>
                {(d) => <div class={d().overdue ? "text-bad" : "text-warn"}>due {d().text}</div>}
              </Show>
            </div>
            {menu()}
          </div>
        }
      >
        {(approvalId) => {
          const parts = () => approvalParts(n());
          // The card is the whole row, its dot and menu inside it, so on a phone its text has
          // the screen's width; its title says who asks, and its foot when.
          return (
            <>
              <ApprovalCard
                approvalId={approvalId()}
                what={parts().what}
                why={parts().why}
                text={parts().text}
                status={props.row.approvalStatus}
                always={props.row.alwaysAllow}
                byJarvis={n().createdBy === "jarvis"}
                unseen={n().state === "unseen"}
                menu={menu()}
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
              {snoozes()}
            </>
          );
        }}
      </Show>
    </li>
  );
}
