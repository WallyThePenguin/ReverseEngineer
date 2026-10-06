// One line on Today that opens in place: who or what it is, a quieter line under it, and what's at
// its end. Opened, the rest shows under the line (an email's whole text, who it goes to) with the
// buttons that act on it, next to what they act on. A row whose line is all there is to it doesn't
// open, and wraps rather than cut anything off.

import { createUniqueId, type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../../components/icons.tsx";

export function FoldRow(props: {
  /** An avatar, or what kind of thing it is. */
  lead: JSX.Element;
  title: JSX.Element;
  sub?: JSX.Element;
  /** At the end of the line, outside what opens it: a yes for a row that shows all of itself. */
  end?: JSX.Element;
  /** Opens to more under the line; a row without it is only its line. */
  onToggle?: () => void;
  open?: boolean;
  /** What opening it shows. */
  children?: JSX.Element;
}) {
  const id = createUniqueId();
  const cut = () => (props.onToggle ? "truncate" : "break-words");
  // Each branch makes its own, so neither takes the other's nodes.
  const line = () => (
    <>
      {props.lead}
      <span class="min-w-0 flex-1">
        <span class={`block text-sm font-medium ${cut()}`}>{props.title}</span>
        <Show when={props.sub}>
          {(sub) => <span class={`block text-meta text-muted ${cut()}`}>{sub()}</span>}
        </Show>
      </span>
    </>
  );
  return (
    <li class="border-b border-line last:border-b-0">
      {/* Narrow, what's at the end goes under the line rather than squeeze it. */}
      <div class="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 py-2 pr-2 pl-3 md:min-h-12">
        <Show
          when={props.onToggle}
          fallback={<span class="flex min-w-0 flex-[1_1_15rem] items-center gap-3">{line()}</span>}
        >
          <button
            type="button"
            class="-my-1 flex min-w-0 flex-[1_1_15rem] items-center gap-3 rounded-md py-1 text-left hover:bg-sunk/60"
            aria-expanded={props.open === true}
            aria-controls={id}
            onClick={() => props.onToggle?.()}
          >
            {line()}
            <Icon
              name="chevron-down"
              class={`shrink-0 text-faint transition-transform motion-reduce:transition-none ${props.open ? "rotate-180" : ""}`}
            />
          </button>
        </Show>
        <Show when={props.end}>{(end) => <span class="ml-auto shrink-0">{end()}</span>}</Show>
      </div>
      <Show when={props.open}>
        <div id={id} class="animate-enter pr-3 pb-3 pl-3 @md:pl-14">
          {props.children}
        </div>
      </Show>
    </li>
  );
}

/** A row's lead for what isn't a person: what kind of thing it is, on a quiet round tint. */
export function KindMark(props: { icon: IconName }) {
  return (
    <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-sunk text-muted">
      <Icon name={props.icon} />
    </span>
  );
}
