// A doc's history: scrub through its versions, see who wrote each, put one back, and name the
// ones worth keeping (PLAN.md section 8.5). Restoring is a new edit, so nothing is lost.

import { stripMentions } from "@hearth/core";
import { createSignal, For, Show } from "solid-js";
import { day, time, who } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import { Button } from "./ui.tsx";

type Frontiers = { peer: string; counter: number }[];
interface Version {
  at: string | null;
  by: string[];
  frontiers: Frontiers;
}
interface Checkpoint {
  id: string;
  name: string;
  frontiers: Frontiers;
  createdAt: string;
}

const when = (iso: string | null) =>
  iso ? `${day(new Date(iso))}, ${time(new Date(iso))}` : "Earlier";
const writers = (by: string[]) =>
  by.map((p) => (p === "someone" ? "Someone" : who(p))).join(" and ");

export function DocHistory(props: { id: string; onClose: () => void }) {
  const history = useAction<{ versions: Version[]; checkpoints: Checkpoint[] }>(
    "doc.history",
    () => ({ id: props.id }),
  );
  const versions = () => history.data?.versions ?? [];
  // 0 is the newest version; the slider runs oldest to newest.
  const [index, setIndex] = createSignal(0);
  const [picked, setPicked] = createSignal<Checkpoint | null>(null);
  const [naming, setNaming] = createSignal(false);
  const shown = () => picked()?.frontiers ?? versions()[index()]?.frontiers;
  const text = useAction<{ text: string }>(
    "doc.version",
    () => ({ id: props.id, frontiers: shown() }),
    () => Boolean(shown()),
  );
  const label = () => {
    const c = picked();
    if (c) return `Checkpoint "${c.name}", ${when(c.createdAt)}`;
    const v = versions()[index()];
    if (!v) return "";
    return `${index() === 0 ? "Now" : when(v.at)} · ${writers(v.by)}`;
  };

  const restore = async () => {
    const f = shown();
    if (!f) return;
    if (await act("doc.restore", { id: props.id, frontiers: f })) {
      toast.show("Put back. The versions since are still in the history.");
      props.onClose();
    }
  };
  const checkpoint = async (name: string) => {
    setNaming(false);
    if (!name.trim()) return;
    const f = picked() ? undefined : index() === 0 ? undefined : shown();
    if (await act("doc.checkpoint", { id: props.id, name, ...(f ? { frontiers: f } : {}) }))
      toast.show(`Saved checkpoint "${name.trim()}".`);
  };

  return (
    <section class="space-y-3" aria-label="History">
      <div class="flex items-center gap-3">
        <Show when={versions().length > 1}>
          <input
            type="range"
            class="flex-1"
            aria-label="Scrub through versions"
            min={0}
            max={versions().length - 1}
            value={versions().length - 1 - index()}
            onInput={(e) => {
              setPicked(null);
              setIndex(versions().length - 1 - Number(e.currentTarget.value));
            }}
          />
        </Show>
        <span class="shrink-0 text-xs text-muted">{label()}</span>
      </div>
      <Show
        when={versions().length > 0}
        fallback={
          <p class="text-sm text-muted">
            {history.isLoading ? "Loading…" : "No history yet: it starts with the next edit."}
          </p>
        }
      >
        <pre class="max-h-[50vh] min-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunk p-3 font-sans text-[15px]">
          {stripMentions(text.data?.text ?? "")}
        </pre>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={index() !== 0 || picked()}>
            <Button kind="primary" small onClick={() => void restore()}>
              Restore this version
            </Button>
          </Show>
          <Show
            when={naming()}
            fallback={
              <Button small onClick={() => setNaming(true)}>
                Save as checkpoint
              </Button>
            }
          >
            <input
              class="rounded-md border border-line bg-panel px-2 py-0.5 text-sm"
              placeholder="Name this version"
              maxLength={100}
              ref={(el) => queueMicrotask(() => el.focus())}
              onKeyDown={(e) => {
                if (e.key === "Enter") void checkpoint(e.currentTarget.value);
                if (e.key === "Escape") setNaming(false);
              }}
            />
          </Show>
          <Button small onClick={props.onClose}>
            Back to editing
          </Button>
        </div>
      </Show>
      <Show when={(history.data?.checkpoints.length ?? 0) > 0}>
        <div>
          <h3 class="mb-1 text-xs font-medium uppercase tracking-wide text-faint">Checkpoints</h3>
          <ul class="space-y-1">
            <For each={history.data?.checkpoints}>
              {(c) => (
                <li class="flex items-center gap-2 text-sm">
                  <button
                    type="button"
                    class="flex-1 truncate text-left hover:underline"
                    classList={{ "font-semibold": picked()?.id === c.id }}
                    onClick={() => setPicked(c)}
                  >
                    {c.name}
                  </button>
                  <span class="text-xs text-faint">{when(c.createdAt)}</span>
                  <button
                    type="button"
                    class="text-xs text-faint hover:text-bad"
                    title="Remove this checkpoint (the version stays in the history)"
                    onClick={() => {
                      if (picked()?.id === c.id) setPicked(null);
                      void act("doc.checkpoint_delete", { id: c.id });
                    }}
                  >
                    Remove
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </section>
  );
}
