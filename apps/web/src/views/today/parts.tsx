// The pieces Today's cards are made of: a card with its sub-product's icon, name, count and "All",
// a row of it in two lines, its one-line empty state, and its loading and failed states.

import { createUniqueId, type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../../components/icons.tsx";
import { Card } from "../../components/kit/Card.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Skeleton } from "../../components/kit/Skeleton.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { Failed } from "../../components/ui.tsx";
import type { AppId } from "../../lib/apps.ts";

/** A card of Today's in its sub-product's colour: what's on today, what's due, what Jarvis did. */
export function TodayCard(props: {
  /** Whose colour its icon takes (index.css). */
  product: AppId;
  icon: IconName | "mark";
  title: string;
  count?: number;
  /** The whole list, in its own place. */
  more?: { label?: string; run: () => void };
  children: JSX.Element;
}) {
  const id = createUniqueId();
  return (
    <div data-product={props.product}>
      <Card labelledby={id} flush>
        <SectionHeader
          id={id}
          class="px-4 pt-2.5 pb-2"
          title={
            <span class="flex items-center gap-2">
              <Show when={props.icon !== "mark"} fallback={<JarvisMark size={14} class="mx-px" />}>
                <Icon name={props.icon as IconName} class="text-hue" />
              </Show>
              {props.title}
            </span>
          }
          count={props.count}
          more={props.more}
        />
        {props.children}
      </Card>
    </div>
  );
}

/**
 * A row of a card: its title over a line of meta, never side by side, since a card is narrow.
 * The whole row opens what it's about; its title is a button, so the keyboard reaches it too.
 */
export function TodayRow(props: {
  lead?: JSX.Element;
  title: JSX.Element;
  meta?: JSX.Element;
  end?: JSX.Element;
  onOpen?: (beside: boolean) => void;
  /** Over, as a meeting that has ended: quieter. */
  quiet?: boolean;
  /** What the row's button says to a screen reader, when its title alone doesn't. */
  label?: string;
  /** Under the title and what's at its end, as wide as both: answers to an invitation, say. */
  below?: JSX.Element;
}) {
  return (
    <li
      class={`grid min-h-14 gap-x-3 border-t border-line px-4 py-2 md:min-h-12 ${props.lead ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]"} ${props.onOpen ? "cursor-pointer hover:bg-sunk/60" : ""} ${props.quiet ? "text-muted" : ""}`}
      onClick={(e) => props.onOpen?.(e.shiftKey)}
    >
      <Show when={props.lead}>
        <div class="flex items-start pt-0.5">{props.lead}</div>
      </Show>
      <div class="min-w-0">
        <Show when={props.onOpen} fallback={<p class="text-sm break-words">{props.title}</p>}>
          <button
            type="button"
            class="block w-full min-w-0 text-left text-sm break-words"
            aria-label={props.label}
          >
            {props.title}
          </button>
        </Show>
        <Show when={props.meta}>
          {(meta) => <p class="mt-0.5 truncate text-meta text-muted">{meta()}</p>}
        </Show>
      </div>
      <div class="flex items-start gap-2 pt-0.5">{props.end}</div>
      <Show when={props.below}>
        <div class={`col-span-2 mt-1.5 min-w-0 ${props.lead ? "col-start-2" : ""}`}>
          {props.below}
        </div>
      </Show>
    </li>
  );
}

/** A card with nothing in it: one quiet line. */
export function CardEmpty(props: { children: JSX.Element }) {
  return <p class="border-t border-line px-4 py-4 text-sm text-muted">{props.children}</p>;
}

/** A card's read on its way (a few grey rows) or failed (with Try again). */
export function CardWaiting(props: { query: QueryRead<unknown>; what: string; rows?: number }) {
  return (
    <div class="border-t border-line">
      <Show when={props.query.isError} fallback={<Skeleton count={props.rows ?? 2} />}>
        <Failed error={props.query.error} retry={props.query.refetch} what={props.what} />
      </Show>
    </div>
  );
}
