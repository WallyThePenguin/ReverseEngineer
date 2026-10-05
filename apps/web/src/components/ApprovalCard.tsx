// An approval, as a card wherever one shows: what Jarvis (or another asker) wants to do, why it
// needs your yes, and exactly what would happen, in full. The text scrolls inside its box and is
// never cut short, and a card waiting for you has no way to put it off: no snooze, no dismiss,
// only a yes or a no (D58). Once it's decided, it says what became of it.

import { children, createUniqueId, type JSX, Show } from "solid-js";
import { approvalStateText, decide, deciding, isWaiting } from "../lib/approvals.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Card } from "./kit/Card.tsx";
import { JarvisMark } from "./Mark.tsx";
import { Button, Kbd } from "./ui.tsx";

/** What became of an approval, with its icon: status always comes with one (D65). */
const OUTCOME: Record<string, { icon: IconName; class: string }> = {
  executing: { icon: "loader-circle", class: "animate-spin text-muted" },
  executed: { icon: "ok", class: "text-ok" },
  denied: { icon: "x", class: "text-muted" },
  failed: { icon: "bad", class: "text-bad" },
  expired: { icon: "alarm-clock", class: "text-muted" },
};

const HEADING = "min-w-0 flex-1 text-heading break-words";

export function ApprovalCard(props: {
  approvalId: string;
  /** What it would do, in a line: `Jarvis asks: Send an email to dana@…`. */
  what: string;
  /** Why it needs your yes, in Hearth's words. */
  why?: string | null;
  /** Exactly what would happen, such as an email's whole text. */
  text?: string | null;
  /** "pending" while it waits for you, then what became of it. */
  status: string | null;
  /** Jarvis is the one asking: the card carries its mark. */
  byJarvis?: boolean;
  /** When it was asked (and any deadline), beside its buttons. */
  meta?: JSX.Element;
  /** Shows a and d on its buttons, where the list's keys decide it. */
  keys?: boolean;
  /** h2 by default; h3 inside a section that has a heading of its own. */
  level?: 2 | 3;
  /** Placement only (a margin); the look is the card's. */
  class?: string;
}) {
  const id = createUniqueId();
  const meta = children(() => props.meta);
  const waiting = () => isWaiting(props.approvalId, props.status);
  // Decided here a moment ago, before the lists catch up with what became of it.
  const outcome = () =>
    props.status === "pending"
      ? { text: "Decided", icon: "check" as const, class: "text-muted" }
      : {
          text: approvalStateText(props.status!),
          ...(OUTCOME[props.status!] ?? { icon: "info" as const, class: "text-muted" }),
        };
  return (
    <Card labelledby={id} class={props.class}>
      <div class="flex items-start gap-2">
        <Show when={props.byJarvis}>
          <JarvisMark size={18} class="mt-0.5" />
        </Show>
        {/* Two plain headings: Dynamic (or a spread) would bring Solid's spread code along. */}
        <Show
          when={props.level === 3}
          fallback={
            <h2 id={id} class={HEADING}>
              {props.what}
            </h2>
          }
        >
          <h3 id={id} class={HEADING}>
            {props.what}
          </h3>
        </Show>
      </div>
      <Show when={props.why}>{(why) => <p class="mt-1 text-sm text-muted">{why()}</p>}</Show>
      <Show when={props.text}>
        {(text) => (
          // Exactly what would happen, as plain text and in full: long text scrolls in its box,
          // with a shade at an edge while there's more past it. It takes the keyboard's focus,
          // so it scrolls without a mouse too: there the arrow keys scroll it, rather than move
          // the list's selection off the card you're reading.
          <pre
            tabindex="0"
            onKeyDown={(e) => {
              const box = e.currentTarget;
              const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
              if (arrow && box.scrollHeight > box.clientHeight) e.stopPropagation();
            }}
            class="scroll-fade mt-3 max-h-64 overflow-auto rounded-md border border-line p-3 font-sans text-sm break-words whitespace-pre-wrap"
          >
            {text()}
          </pre>
        )}
      </Show>
      <Show when={props.status || meta()}>
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-muted">
          <Show when={!waiting() && props.status}>
            <p class="flex items-center gap-1.5">
              <Icon name={outcome().icon} size={14} class={outcome().class} />
              {outcome().text}
            </p>
          </Show>
          <Show when={meta()}>
            <span class="tabular-nums">{meta()}</span>
          </Show>
          <Show when={waiting()}>
            <div class="ml-auto flex gap-2" onClick={(e) => e.stopPropagation()}>
              <Button
                kind="danger"
                small
                icon="x"
                disabled={deciding(props.approvalId)}
                onClick={() => decide(props.approvalId, "deny")}
              >
                Deny{" "}
                <Show when={props.keys}>
                  <Kbd>d</Kbd>
                </Show>
              </Button>
              <Button
                kind="primary"
                small
                icon="check"
                disabled={deciding(props.approvalId)}
                onClick={() => decide(props.approvalId, "approve")}
              >
                Approve{" "}
                <Show when={props.keys}>
                  <Kbd>a</Kbd>
                </Show>
              </Button>
            </div>
          </Show>
        </div>
      </Show>
    </Card>
  );
}
