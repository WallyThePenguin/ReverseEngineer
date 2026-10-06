// An approval, as a card wherever one shows (the inbox, a conversation with Jarvis): what Jarvis
// (or another asker) wants to do, why it needs your yes, and exactly what would happen, in full.
// Long text scrolls in its box and opens with "Show all", never cut short, and a card waiting for
// you has no way to put it off: no snooze, no dismiss, only a yes or a no (D58). Once it's
// decided, it says what became of it.

import {
  children,
  createEffect,
  createSignal,
  createUniqueId,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  approvalStateText,
  decide,
  decidedAs,
  deciding,
  isWaiting,
  type Said,
} from "../lib/approvals.ts";
import { humanTimes } from "../lib/format.ts";
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
  gone: { icon: "info", class: "text-muted" },
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
  /**
   * "pending" while it waits for you, then what became of it ("gone" when all that's known is
   * that it no longer waits), or null while that isn't known yet.
   */
  status: string | null;
  /** Jarvis is the one asking: the card carries its mark. */
  byJarvis?: boolean;
  /** You haven't seen it yet: a dot before it, as on the list's other rows. */
  unseen?: boolean;
  /** At the end of its heading: the list row's "more" menu, inside the card on a phone's width. */
  menu?: JSX.Element;
  /** When it was asked (and any deadline), beside its buttons. */
  meta?: JSX.Element;
  /** Shows a and d on its buttons, where the list's keys decide it (not on a touch screen). */
  keys?: boolean;
  /** h2 by default; h3 inside a section that has a heading of its own. */
  level?: 2 | 3;
  /** Its exact text shown in full from the start, as under Today's "Approve all", which covers it. */
  open?: boolean;
  /** More about what it would do, over its text: who a send reaches that's new, on Today. */
  children?: JSX.Element;
  /** Placement only (a margin); the look is the card's. */
  class?: string;
}) {
  const id = createUniqueId();
  const meta = children(() => props.meta);
  const menu = children(() => props.menu);
  const waiting = () => isWaiting(props.approvalId, props.status);
  // The calendar's times as you'd say them; the rest of it, and the text, exactly as written.
  const what = () => humanTimes(props.what);
  // What became of it: Hearth's word for it once the lists have it, and until then what came of
  // deciding it here (your yes or no, or what Hearth said someone else had done first).
  const state = () => {
    const s = props.status;
    return s && s !== "pending" && s !== "gone" ? s : (decidedAs(props.approvalId) ?? s);
  };
  const outcome = () => {
    const s = state() ?? "gone";
    return {
      text: approvalStateText(s),
      ...(OUTCOME[s] ?? { icon: "info" as const, class: "text-muted" }),
    };
  };
  return (
    <Card labelledby={id} class={props.class}>
      <div class="flex items-start gap-2">
        <Show when={props.unseen}>
          <span class="mt-2 size-2 shrink-0 rounded-full bg-accent" />
        </Show>
        <Show when={props.byJarvis}>
          <JarvisMark size={18} class="mt-0.5" />
        </Show>
        {/* Two plain headings: Dynamic (or a spread) would bring Solid's spread code along. */}
        <Show
          when={props.level === 3}
          fallback={
            <h2 id={id} class={HEADING}>
              {what()}
            </h2>
          }
        >
          <h3 id={id} class={HEADING}>
            {what()}
          </h3>
        </Show>
        <Show when={menu()}>
          <div class="-my-2.5 -mr-2.5 shrink-0 md:my-0 md:mr-0">{menu()}</div>
        </Show>
      </div>
      <Show when={props.why}>{(why) => <p class="mt-1 text-sm text-muted">{why()}</p>}</Show>
      {props.children}
      <Show when={props.text}>{(text) => <ExactText text={text()} open={props.open} />}</Show>
      <Show when={state() || meta()}>
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-muted">
          <Show when={!waiting() && state()}>
            <p class="flex items-center gap-1.5">
              <Icon name={outcome().icon} size={14} class={outcome().class} />
              {outcome().text}
            </p>
          </Show>
          <Show when={meta()}>
            <span class="tabular-nums">{meta()}</span>
          </Show>
          <Show when={waiting()}>
            <Decide approvalId={props.approvalId} keys={props.keys} class="ml-auto" />
          </Show>
        </div>
      </Show>
    </Card>
  );
}

/**
 * Deny and Approve, for an approval still waiting: off while a decision is on its way. Approve is
 * the one filled button; Deny, which leaves everything as it is, stays quiet beside it.
 */
export function Decide(props: {
  approvalId: string;
  /** Shows a and d on them, where the list's keys decide it. */
  keys?: boolean;
  /** What the yes says once it's done, rather than "Approved and done." */
  said?: Said;
  class?: string;
}) {
  return (
    <div class={`flex gap-1 ${props.class ?? ""}`} onClick={(e) => e.stopPropagation()}>
      <Button
        kind="quiet"
        small
        icon="x"
        disabled={deciding(props.approvalId)}
        onClick={() => decide(props.approvalId, "deny")}
      >
        Deny{" "}
        <Show when={props.keys}>
          <Kbd hint>d</Kbd>
        </Show>
      </Button>
      <Button
        kind="primary"
        small
        icon="check"
        disabled={deciding(props.approvalId)}
        onClick={() => decide(props.approvalId, "approve", props.said)}
      >
        Approve{" "}
        <Show when={props.keys}>
          <Kbd hint>a</Kbd>
        </Show>
      </Button>
    </div>
  );
}

/**
 * Exactly what would happen, as plain text and in full. Long text sits in a box that scrolls, on a
 * phone as on a computer, with a shade at the edge that has more, and "Show all" opens the rest
 * right there. Nothing in it is ever out of reach: no line is hidden where it can't be scrolled
 * to, since you decide on all of it (D58). The arrow keys scroll it once it has the focus, rather
 * than move the list's selection off the card you're reading.
 */
export function ExactText(props: { text: string; open?: boolean }) {
  // Open from the start, it has no box to scroll and nothing to show more of.
  const [all, setAll] = createSignal(props.open === true);
  const [more, setMore] = createSignal(false);
  let box!: HTMLPreElement;
  const measure = () => {
    if (!all()) setMore(box.scrollHeight > box.clientHeight + 1);
  };
  onMount(() => {
    const resized = new ResizeObserver(measure);
    resized.observe(box);
    onCleanup(() => resized.disconnect());
  });
  createEffect(on([() => props.text], () => queueMicrotask(measure)));
  // A phone's box is shorter, so a card's buttons and the next card stay in sight.
  const fold = () => (all() ? "" : "max-h-48 overflow-auto md:max-h-64");
  return (
    <>
      <pre
        ref={box}
        tabindex="0"
        onKeyDown={(e) => {
          const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
          if (arrow && box.scrollHeight > box.clientHeight) e.stopPropagation();
        }}
        class={`scroll-fade mt-3 rounded-md border border-line p-3 font-sans text-sm break-words whitespace-pre-wrap ${fold()}`}
      >
        {props.text}
      </pre>
      <Show when={more()}>
        <button
          type="button"
          class="-mb-2 flex min-h-11 items-center gap-1 text-meta font-medium text-muted hover:text-ink md:mb-0 md:min-h-0 md:pt-1.5"
          aria-expanded={all()}
          onClick={(e) => {
            e.stopPropagation();
            setAll(!all());
          }}
        >
          <Icon name="chevron-down" size={14} class={all() ? "rotate-180" : ""} />
          {all() ? "Show less" : "Show all"}
        </button>
      </Show>
    </>
  );
}
