// What Jarvis remembers: the list of memory notes, and on each note, when it's used, its text,
// and every earlier version with a way to go back.

import { createSignal, For, Show } from "solid-js";
import { EditableBody } from "../components/EditableBody.tsx";
import { Badge, Button, Empty, PaneHeader } from "../components/ui.tsx";
import { ago, who } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { MemoryNote, MemoryRevision } from "../lib/types.ts";

function ScopeBadge(props: { scope: MemoryNote["scope"] }) {
  return props.scope === "always" ? <Badge tone="jarvis">always</Badge> : <Badge>by topic</Badge>;
}

export function Memory(props: { pane: number }) {
  const notes = useAction<MemoryNote[]>("memory.list");
  const [title, setTitle] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const list = () => notes.data ?? [];
  const focused = () => layout.focused() === props.pane;
  const open = (n: MemoryNote | undefined) =>
    n && layout.show({ view: "record", id: n.id }, props.pane);

  useHotkeys([
    ...listKeys({ count: () => list().length, index, setIndex, when: focused }),
    { keys: "enter", run: () => open(list()[index()]), when: focused, label: "Open memory" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Memory" sub="What Jarvis remembers about you" />
      <form
        class="border-b border-line px-4 py-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const t = title().trim();
          if (!t) return;
          const created = await act<MemoryNote>("memory.remember", { title: t, body: "" });
          if (created) {
            setTitle("");
            layout.show({ view: "record", id: created.id }, props.pane);
          }
        }}
      >
        <input
          class="w-full bg-transparent py-1 outline-none placeholder:text-faint"
          placeholder="Add something for Jarvis to remember…"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </form>
      <div class="flex-1 overflow-auto">
        <Show
          when={list().length > 0}
          fallback={
            <Empty>
              Nothing yet. Tell Jarvis about yourself in chat and it will keep notes here.
            </Empty>
          }
        >
          <ul>
            <For each={list()}>
              {(n, i) => (
                <li
                  class="flex cursor-pointer items-baseline gap-3 border-b border-line px-4 py-2"
                  data-active={focused() && i() === index()}
                  onClick={() => {
                    setIndex(i());
                    open(n);
                  }}
                >
                  <span class="flex-1 truncate">{n.title}</span>
                  <ScopeBadge scope={n.scope} />
                  <span class="text-xs text-faint">
                    {who(n.updatedBy)} · {ago(n.updatedAt)}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

/** A memory note's own part of its record: when it's used, its text, and its versions. */
export function MemoryPanel(props: { id: string }) {
  const note = useAction<MemoryNote>("memory.get", () => ({ id: props.id }));
  const history = useAction<MemoryRevision[]>("memory.history", () => ({ id: props.id }));
  const update = (patch: Partial<MemoryNote>) =>
    act<MemoryNote>("memory.update", {
      id: props.id,
      expectedRevision: note.data?.revision,
      ...patch,
    });
  return (
    <Show when={note.data}>
      {(n) => (
        <div class="space-y-5">
          <div class="space-y-2 rounded-md bg-sunk px-3 py-3 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-muted">Jarvis uses this</span>
              <Button
                small
                kind={n().scope === "always" ? "jarvis" : "plain"}
                onClick={() => void update({ scope: "always" })}
              >
                in every answer
              </Button>
              <Button
                small
                kind={n().scope === "topic" ? "jarvis" : "plain"}
                onClick={() => void update({ scope: "topic" })}
              >
                when its topic comes up
              </Button>
            </div>
            <Show when={n().scope === "topic"}>
              <label class="flex items-center gap-2">
                <span class="text-muted">Topic words</span>
                <input
                  class="flex-1 rounded border border-line bg-panel px-2 py-0.5"
                  value={n().keywords.join(", ")}
                  placeholder="dentist, teeth"
                  onChange={(e) =>
                    void update({
                      keywords: e.currentTarget.value
                        .split(",")
                        .map((w) => w.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </Show>
          </div>
          <EditableBody
            body={n().body}
            placeholder="What should Jarvis remember? Click to write."
            save={async (body) => Boolean(await update({ body }))}
          />
          <Show when={(history.data ?? []).length > 1}>
            <section class="space-y-1">
              <h2 class="text-sm font-semibold">Earlier versions</h2>
              <ul class="space-y-1">
                <For each={(history.data ?? []).slice(1)}>
                  {(r) => (
                    <li class="rounded-md border border-line px-3 py-2 text-sm">
                      <p class="flex items-center gap-2 text-xs text-muted">
                        <span class="flex-1">
                          Version {r.revision} · {who(r.changedBy)} · {ago(r.at)}
                          {r.reason ? ` · ${r.reason}` : ""}
                        </span>
                        <Button
                          small
                          onClick={async () => {
                            if (await act("memory.revert", { id: props.id, revision: r.revision }))
                              toast.show(`Back to version ${r.revision}.`);
                          }}
                        >
                          Go back to this
                        </Button>
                      </p>
                      <pre class="mt-1 whitespace-pre-wrap font-sans text-xs">{r.body}</pre>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </div>
      )}
    </Show>
  );
}
