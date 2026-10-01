// Both sides of every link: what this record mentions, and what mentions it.

import { For, Show } from "solid-js";
import { TYPE_LABEL } from "../lib/format.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import type { LinkRow, Links } from "../lib/types.ts";

function LinkList(props: { title: string; rows: LinkRow[] }) {
  // A note that mentions this twice is listed once.
  const unique = () => [...new Map(props.rows.map((r) => [r.otherId, r])).values()];
  return (
    <Show when={unique().length > 0}>
      <div>
        <h3 class="mb-1 text-xs font-medium uppercase tracking-wide text-faint">{props.title}</h3>
        <ul class="space-y-0.5">
          <For each={unique()}>
            {(l) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-sunk"
                  onClick={(e) =>
                    layout.open(routeFor(l.otherType, l.otherId), { beside: e.shiftKey })
                  }
                >
                  <span class="w-16 shrink-0 text-xs text-faint">
                    {TYPE_LABEL[l.otherType] ?? l.otherType}
                  </span>
                  <span class="truncate">{l.otherTitle || "Untitled"}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

export function Backlinks(props: { id: string }) {
  const links = useAction<Links>("entity.links", () => ({ id: props.id }));
  // Comments are shown in the thread, not as links.
  const incoming = () => (links.data?.incoming ?? []).filter((l) => l.otherType !== "comment");
  return (
    <Show when={links.data && (incoming().length > 0 || links.data.outgoing.length > 0)}>
      <section class="space-y-3 border-t border-line pt-4">
        <LinkList title="Linked from" rows={incoming()} />
        <LinkList title="Links to" rows={links.data?.outgoing ?? []} />
      </section>
    </Show>
  );
}
