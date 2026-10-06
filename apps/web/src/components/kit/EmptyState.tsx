// What a screen shows when there's nothing in it: a tile in the sub-product's colour, a title,
// one sentence, and the one thing to do next. `Empty` (components/ui.tsx) is the sentence alone.

import { type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../icons.tsx";

export function EmptyState(props: {
  /** The tile's icon, in the colour of the sub-product the pane belongs to. No icon, no tile. */
  icon?: IconName;
  title?: JSX.Element;
  /** One sentence: why it's empty, or what will fill it. */
  children?: JSX.Element;
  /** The one thing to do: a primary button. */
  action?: JSX.Element;
  class?: string;
}) {
  return (
    <div class={`flex flex-col items-center gap-2 px-4 py-10 text-center ${props.class ?? ""}`}>
      <Show when={props.icon}>
        {(name) => (
          <span class="mb-1 flex size-12 items-center justify-center rounded-lg bg-hue/10 text-hue">
            <Icon name={name()} size={24} />
          </span>
        )}
      </Show>
      {/* Each part is drawn from what `when` made, so it's made once. */}
      <Show when={props.title}>{(title) => <h2 class="text-heading">{title()}</h2>}</Show>
      <Show when={props.children}>
        {(text) => <p class="max-w-sm text-sm text-muted">{text()}</p>}
      </Show>
      <Show when={props.action}>{(action) => <div class="mt-2">{action()}</div>}</Show>
    </div>
  );
}
