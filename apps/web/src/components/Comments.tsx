// The thread under a task or note. @Jarvis here and the answer comes back in the thread.

import { fromEditForm } from "@hearth/core";
import { createSignal, For, Show } from "solid-js";
import { ago, who } from "../lib/format.ts";
import { act, useAction } from "../lib/query.ts";
import type { Entity, Turn } from "../lib/types.ts";
import { Body } from "./Body.tsx";
import { MentionEditor } from "./MentionEditor.tsx";

export function JarvisWorking(props: { subjectId: string }) {
  const turns = useAction<Turn[]>("jarvis.activity", () => ({ limit: 30 }));
  const working = () =>
    (turns.data ?? []).some(
      (t) => t.subjectId === props.subjectId && (t.status === "queued" || t.status === "running"),
    );
  return (
    <Show when={working()}>
      <p class="flex items-center gap-2 text-sm text-jarvis">
        <span class="inline-block size-2 animate-pulse rounded-full bg-jarvis" />
        Jarvis is on it…
      </p>
    </Show>
  );
}

export function Comments(props: { parentId: string }) {
  const comments = useAction<Entity[]>("comment.list", () => ({ parentId: props.parentId }));
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);

  const send = async () => {
    const text = draft().trim();
    if (!text || sending()) return;
    setSending(true);
    const made = await act("comment.create", {
      parentId: props.parentId,
      body: fromEditForm(text),
    });
    setSending(false);
    if (made) setDraft("");
  };

  return (
    <section class="space-y-3 border-t border-line pt-4">
      <h3 class="text-xs font-medium uppercase tracking-wide text-faint">Thread</h3>
      <For each={comments.data ?? []}>
        {(c) => (
          <div
            class={`rounded-md px-3 py-2 ${c.createdBy === "jarvis" ? "bg-jarvis-soft" : "bg-sunk"}`}
          >
            <div class="mb-1 flex gap-2 text-xs text-muted">
              <span class={c.createdBy === "jarvis" ? "font-medium text-jarvis" : "font-medium"}>
                {who(c.createdBy)}
              </span>
              <span>{ago(c.createdAt)}</span>
            </div>
            <Body text={c.body} />
          </div>
        )}
      </For>
      <JarvisWorking subjectId={props.parentId} />
      <MentionEditor
        value={draft()}
        onInput={setDraft}
        onSubmit={send}
        rows={2}
        placeholder="Comment, or @Jarvis to ask for help (Ctrl+Enter to send)"
      />
      <div class="flex justify-end">
        <button
          type="button"
          class="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
          disabled={!draft().trim() || sending()}
          onClick={send}
        >
          Comment
        </button>
      </div>
    </section>
  );
}
