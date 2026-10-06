// Voice: everything you've dictated (fix a word and the dictionary learns it), your dictionary,
// snippets, and how dictation is written in each app (PLAN.md section 7.2).

import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { NoRows } from "../components/QueryView.tsx";
import { Badge, Button, PaneHeader } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import { Samples } from "./VoiceSamples.tsx";

interface Dictation {
  id: string;
  text: string;
  raw: string;
  app: string | null;
  style: string | null;
  polished: boolean;
  cleanupMs: number;
  createdAt: string;
}
interface Entry {
  id: string;
  heard: string | null;
  write: string;
  learned: boolean;
}
interface Snippet {
  id: string;
  trigger: string;
  text: string;
}
interface Style {
  name: string;
  match: string;
  instructions: string;
}

type Tab = "history" | "dictionary" | "snippets" | "styles" | "samples";
const TABS: { tab: Tab; label: string }[] = [
  { tab: "history", label: "History" },
  { tab: "dictionary", label: "Dictionary" },
  { tab: "snippets", label: "Snippets" },
  { tab: "styles", label: "Styles" },
  { tab: "samples", label: "Voice samples" },
];

const input = "rounded-md border border-line bg-panel px-2 py-1 text-sm";

export function Voice() {
  const [tab, setTab] = createSignal<Tab>("history");
  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Dictation" sub="What you've dictated, and how it's cleaned up" />
      <div role="tablist" class="flex gap-1 border-b border-line px-4 py-1.5">
        <For each={TABS}>
          {(t) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === t.tab}
              class="rounded px-2 py-0.5 text-sm"
              classList={{ "bg-sunk font-medium": tab() === t.tab, "text-muted": tab() !== t.tab }}
              onClick={() => setTab(t.tab)}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>
      <div class="flex-1 overflow-auto">
        <Switch>
          <Match when={tab() === "history"}>
            <History />
          </Match>
          <Match when={tab() === "dictionary"}>
            <Dictionary />
          </Match>
          <Match when={tab() === "snippets"}>
            <Snippets />
          </Match>
          <Match when={tab() === "styles"}>
            <Styles />
          </Match>
          <Match when={tab() === "samples"}>
            <Samples />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function Row(props: { children: JSX.Element }) {
  return <li class="border-b border-line px-4 py-2.5">{props.children}</li>;
}

function History() {
  const [query, setQuery] = createSignal("");
  const list = useAction<Dictation[]>("dictation.list", () => ({
    ...(query().trim() ? { query: query().trim() } : {}),
    limit: 100,
  }));
  const [editing, setEditing] = createSignal<string | null>(null);
  const fix = async (d: Dictation, text: string) => {
    setEditing(null);
    if (text.trim() === d.text) return;
    const r = await act<{ learned: { heard: string; write: string }[] }>("dictation.fix", {
      id: d.id,
      text,
    });
    const l = r?.learned[0];
    if (l) toast.show(`Learned: "${l.heard}" is written "${l.write}".`);
  };
  return (
    <div>
      <div class="px-4 py-2">
        <input
          class={`${input} w-full`}
          placeholder="Search what you've said…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
      <Show
        when={(list.data ?? []).length > 0}
        fallback={
          <NoRows query={list} what="your dictation history">
            Nothing dictated yet. Hold the dictation hotkey in the desktop app and talk.
          </NoRows>
        }
      >
        <ul>
          <For each={list.data}>
            {(d) => (
              <Row>
                <div class="mb-1 flex items-center gap-2 text-xs text-faint">
                  <span>{ago(d.createdAt)}</span>
                  <Show when={d.app}>
                    <span>· {d.app}</span>
                  </Show>
                  <Show when={d.style}>
                    <Badge>{d.style!}</Badge>
                  </Show>
                  <span class="flex-1" />
                  <button
                    type="button"
                    class="hover:text-ink"
                    onClick={() => void navigator.clipboard.writeText(d.text)}
                  >
                    Copy
                  </button>
                  <button type="button" class="hover:text-ink" onClick={() => setEditing(d.id)}>
                    Fix
                  </button>
                </div>
                <Show when={editing() === d.id} fallback={<p class="text-sm">{d.text}</p>}>
                  <textarea
                    class={`${input} w-full`}
                    rows={3}
                    value={d.text}
                    ref={(el) => queueMicrotask(() => el.focus())}
                    onBlur={(e) => void fix(d, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                  <p class="mt-1 text-xs text-faint">Heard: {d.raw}</p>
                </Show>
              </Row>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function Dictionary() {
  const list = useAction<Entry[]>("dictionary.list");
  const [heard, setHeard] = createSignal("");
  const [write, setWrite] = createSignal("");
  return (
    <div>
      <form
        class="flex flex-wrap items-center gap-2 px-4 py-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!write().trim()) return;
          const ok = await act("dictionary.add", {
            write: write().trim(),
            ...(heard().trim() ? { heard: heard().trim() } : {}),
          });
          if (ok) {
            setHeard("");
            setWrite("");
          }
        }}
      >
        <input
          class={input}
          placeholder="When it hears… (optional)"
          value={heard()}
          onInput={(e) => setHeard(e.currentTarget.value)}
        />
        <input
          class={input}
          placeholder="Write it as"
          value={write()}
          onInput={(e) => setWrite(e.currentTarget.value)}
        />
        <Button kind="primary" small submit>
          Add
        </Button>
      </form>
      <Show
        when={(list.data ?? []).length > 0}
        fallback={
          <NoRows query={list} what="your dictionary">
            No words yet. Fixes you make in the history show up here too.
          </NoRows>
        }
      >
        <ul>
          <For each={list.data}>
            {(d) => (
              <Row>
                <div class="flex items-center gap-2 text-sm">
                  <span class="flex-1">
                    <Show when={d.heard} fallback={<span class="text-muted">Spell as </span>}>
                      <span class="text-muted">"{d.heard}" → </span>
                    </Show>
                    <span class="font-medium">{d.write}</span>
                  </span>
                  <Show when={d.learned}>
                    <Badge>learned</Badge>
                  </Show>
                  <button
                    type="button"
                    class="text-xs text-faint hover:text-bad"
                    onClick={() => void act("dictionary.remove", { id: d.id })}
                  >
                    Remove
                  </button>
                </div>
              </Row>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function Snippets() {
  const list = useAction<Snippet[]>("snippet.list");
  const [trigger, setTrigger] = createSignal("");
  const [text, setText] = createSignal("");
  return (
    <div>
      <form
        class="space-y-2 px-4 py-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!trigger().trim() || !text()) return;
          if (await act("snippet.save", { trigger: trigger().trim(), text: text() })) {
            setTrigger("");
            setText("");
          }
        }}
      >
        <input
          class={`${input} w-full`}
          placeholder='When you say… ("my calendar link")'
          value={trigger()}
          onInput={(e) => setTrigger(e.currentTarget.value)}
        />
        <textarea
          class={`${input} w-full`}
          rows={2}
          placeholder="Type this instead"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <Button kind="primary" small submit>
          Add snippet
        </Button>
      </form>
      <Show
        when={(list.data ?? []).length > 0}
        fallback={
          <NoRows query={list} what="your snippets">
            No snippets yet.
          </NoRows>
        }
      >
        <ul>
          <For each={list.data}>
            {(s) => (
              <Row>
                <div class="flex items-center gap-2 text-sm">
                  <span class="font-medium">"{s.trigger}"</span>
                  <span class="min-w-0 flex-1 truncate text-muted">{s.text}</span>
                  <button
                    type="button"
                    class="text-xs text-faint hover:text-bad"
                    onClick={() => void act("snippet.remove", { id: s.id })}
                  >
                    Remove
                  </button>
                </div>
              </Row>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function Styles() {
  const styles = useAction<Style[]>("voice.styles");
  const save = async (next: Style[]) => {
    if (await act("voice.set_styles", { styles: next })) toast.show("Saved.");
  };
  const set = (i: number, patch: Partial<Style>) =>
    void save((styles.data ?? []).map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div class="space-y-3 px-4 py-3">
      <p class="text-sm text-muted">
        When the app or window you're dictating into contains a style's match, its instructions
        shape the cleanup. The first match wins.
      </p>
      <For each={styles.data}>
        {(s, i) => (
          <div class="space-y-1 rounded-md border border-line p-2">
            <div class="flex items-center gap-2">
              <input
                class={input}
                value={s.name}
                aria-label="Name"
                onChange={(e) => set(i(), { name: e.currentTarget.value })}
              />
              <input
                class={`${input} flex-1`}
                value={s.match}
                aria-label="App or window contains"
                onChange={(e) => set(i(), { match: e.currentTarget.value })}
              />
              <button
                type="button"
                class="text-xs text-faint hover:text-bad"
                onClick={() => void save((styles.data ?? []).filter((_, j) => j !== i()))}
              >
                Remove
              </button>
            </div>
            <input
              class={`${input} w-full`}
              value={s.instructions}
              aria-label="How to write"
              onChange={(e) => set(i(), { instructions: e.currentTarget.value })}
            />
          </div>
        )}
      </For>
      <Button
        small
        onClick={() =>
          void save([
            ...(styles.data ?? []),
            { name: "New style", match: "app name", instructions: "" },
          ])
        }
      >
        Add a style
      </Button>
    </div>
  );
}
