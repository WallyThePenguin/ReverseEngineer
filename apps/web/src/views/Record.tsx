// Any other record (a person, a brief, a journal entry, Jarvis itself): what it says, its
// thread and its links.

import { Show } from "solid-js";
import { Backlinks } from "../components/Backlinks.tsx";
import { Body } from "../components/Body.tsx";
import { Comments } from "../components/Comments.tsx";
import { PaneHeader, Placeholder } from "../components/ui.tsx";
import { ago, TYPE_LABEL, who } from "../lib/format.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import type { Entity } from "../lib/types.ts";
import { MemoryPanel } from "./Memory.tsx";
import { PageWatchPanel } from "./PageWatch.tsx";

export function RecordView(props: { id: string; pane: number }) {
  const rec = useAction<Entity>("entity.get", () => ({ id: props.id }));
  // If it turns out to be a task or note, show it in its proper view.
  const redirect = () => {
    const r = rec.data;
    if (r && ["task", "note", "conversation"].includes(r.type)) {
      queueMicrotask(() => layout.open(routeFor(r.type, r.id), { pane: props.pane }));
    }
    return r;
  };
  return (
    <Show when={redirect()} fallback={<Placeholder missing={rec.isError} what="record" />}>
      {(r) => (
        <div class="flex h-full flex-col">
          <PaneHeader
            title={r().title || "Untitled"}
            sub={`${TYPE_LABEL[r().type] ?? r().type} · ${who(r().createdBy)} · ${ago(r().updatedAt)}`}
          />
          <div class="flex-1 space-y-5 overflow-auto px-5 py-4">
            <Show when={r().type === "page_watch"}>
              <PageWatchPanel id={r().id} />
            </Show>
            <Show when={r().type === "memory_note"} fallback={<Body text={r().body} />}>
              <MemoryPanel id={r().id} />
            </Show>
            <Show when={r().type !== "comment"}>
              <Comments parentId={r().id} />
            </Show>
            <Backlinks id={r().id} />
          </div>
        </div>
      )}
    </Show>
  );
}
