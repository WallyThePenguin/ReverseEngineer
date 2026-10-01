// People you know. The personal CRM grows in M5; for now: names, notes and links.

import { createSignal, For, Show } from "solid-js";
import { Empty, PaneHeader } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { Person } from "../lib/types.ts";

export function People(props: { pane: number }) {
  const people = useAction<Person[]>("person.list", () => ({ limit: 200 }));
  const [name, setName] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const list = () => people.data ?? [];
  const focused = () => layout.focused() === props.pane;
  const open = (p: Person | undefined) =>
    p && layout.show({ view: "record", id: p.id }, props.pane);

  useHotkeys([
    ...listKeys({ count: () => list().length, index, setIndex, when: focused }),
    { keys: "enter", run: () => open(list()[index()]), when: focused, label: "Open person" },
  ]);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="People" />
      <form
        class="border-b border-line px-4 py-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (name().trim() && (await act("person.create", { name: name().trim() }))) setName("");
        }}
      >
        <input
          class="w-full bg-transparent py-1 outline-none placeholder:text-faint"
          placeholder="Add a person…"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </form>
      <div class="flex-1 overflow-auto">
        <Show when={list().length > 0} fallback={<Empty>No one yet.</Empty>}>
          <ul>
            <For each={list()}>
              {(p, i) => (
                <li
                  class="flex cursor-pointer items-baseline gap-3 border-b border-line px-4 py-2"
                  data-active={focused() && i() === index()}
                  onClick={() => {
                    setIndex(i());
                    open(p);
                  }}
                >
                  <span class="flex-1 truncate">{p.name}</span>
                  <span class="text-xs text-faint">{ago(p.updatedAt)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
