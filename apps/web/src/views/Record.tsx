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
import { EventPanel } from "./Calendar.tsx";
import { MeetingPanel } from "./Meeting.tsx";
import { MemoryPanel } from "./Memory.tsx";
import { PageWatchPanel } from "./PageWatch.tsx";
import { CompanyPanel, PersonPanel } from "./Person.tsx";

export function RecordView(props: { id: string; pane: number }) {
  const rec = useAction<Entity>("entity.get", () => ({ id: props.id }));
  // If it turns out to be a task or note, show it in its proper view.
  const redirect = () => {
    const r = rec.data;
    if (
      r &&
      ["task", "note", "canvas", "spreadsheet", "conversation", "email", "email_thread"].includes(
        r.type,
      )
    ) {
      queueMicrotask(() => layout.open(routeFor(r.type, r.id), { pane: props.pane }));
    }
    return r;
  };
  return (
    <Show when={redirect()} fallback={<Placeholder query={rec} what="record" />}>
      {(r) => (
        <div class="flex h-full flex-col">
          <PaneHeader
            title={r().title || "Untitled"}
            sub={`${TYPE_LABEL[r().type] ?? r().type} · ${who(r().createdBy)} · ${ago(r().updatedAt)}`}
            record={{ id: r().id, type: r().type, trashed: r().deletedAt !== null }}
          />
          <div class="flex-1 space-y-5 overflow-auto px-5 py-4">
            <Show when={r().type === "event"}>
              <EventPanel id={r().id} />
            </Show>
            <Show when={r().type === "person"}>
              <PersonPanel id={r().id} />
            </Show>
            <Show when={r().type === "meeting"}>
              <MeetingPanel id={r().id} />
            </Show>
            <Show when={r().type === "company"}>
              <CompanyPanel id={r().id} />
            </Show>
            <Show when={r().type === "page_watch"}>
              <PageWatchPanel id={r().id} />
            </Show>
            <Show
              when={r().type === "memory_note"}
              fallback={
                // A meeting's body is your notes, edited in its panel.
                <Show when={r().type !== "meeting"}>
                  <Body text={r().body} />
                </Show>
              }
            >
              <MemoryPanel id={r().id} />
            </Show>
            <Show when={r().type !== "comment"}>
              <Comments parentId={r().id} />
            </Show>
            {/* A person's or company's page already lists what's linked to them. */}
            <Show when={!["person", "company"].includes(r().type)}>
              <Backlinks id={r().id} />
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
