// People you know and the companies they're at, built from your mail and meetings.

import { createSignal, Show } from "solid-js";
import { Empty, PaneHeader } from "../components/ui.tsx";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { Company, Person } from "../lib/types.ts";
import { PeopleRows } from "./Person.tsx";

type Tab = "people" | "companies" | "due";

export function People(props: { pane: number }) {
  const [tab, setTab] = createSignal<Tab>("people");
  const people = useAction<Person[]>("person.list", () => ({ limit: 1000 }));
  const companies = useAction<Company[]>(
    "company.list",
    () => ({ limit: 1000 }),
    () => tab() === "companies",
  );
  const [name, setName] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const due = () => (people.data ?? []).filter((p) => p.overdueDays);
  const rows = (): { id: string }[] =>
    tab() === "companies" ? (companies.data ?? []) : tab() === "due" ? due() : (people.data ?? []);
  const focused = () => layout.focused() === props.pane;
  const open = (r: { id: string } | undefined) =>
    r && layout.show({ view: "record", id: r.id }, props.pane);

  useHotkeys([
    ...listKeys({ count: () => rows().length, index, setIndex, when: focused }),
    { keys: "enter", run: () => open(rows()[index()]), when: focused, label: "Open" },
  ]);

  const tabButton = (t: Tab, label: string) => (
    <button
      type="button"
      class="rounded px-2 py-0.5"
      classList={{ "bg-sunk text-ink": tab() === t, "text-muted": tab() !== t }}
      onClick={() => {
        setTab(t);
        setIndex(0);
      }}
    >
      {label}
    </button>
  );

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="People" />
      <div class="flex gap-1 border-b border-line px-3 py-1.5 text-sm">
        {tabButton("people", "People")}
        {tabButton("companies", "Companies")}
        {tabButton("due", `Get in touch${due().length ? ` (${due().length})` : ""}`)}
      </div>
      <Show when={tab() === "people"}>
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
      </Show>
      <div class="flex-1 overflow-auto">
        <Show when={rows().length > 0} fallback={<Empty>No one yet.</Empty>}>
          <Show
            when={tab() === "companies"}
            fallback={
              <PeopleRows
                rows={tab() === "due" ? due() : (people.data ?? [])}
                active={focused() ? index() : undefined}
                onOpen={(p) => {
                  setIndex(rows().indexOf(p));
                  open(p);
                }}
              />
            }
          >
            <ul>
              {(companies.data ?? []).map((c, i) => (
                <li
                  class="flex cursor-pointer items-baseline gap-3 border-b border-line px-4 py-2"
                  data-active={focused() && i === index()}
                  onClick={() => {
                    setIndex(i);
                    open(c);
                  }}
                >
                  <span class="truncate">{c.name}</span>
                  <span class="flex-1 truncate text-xs text-faint">{c.domain}</span>
                  <span class="text-xs text-faint">
                    {c.people} {c.people === 1 ? "person" : "people"}
                  </span>
                </li>
              ))}
            </ul>
          </Show>
        </Show>
      </div>
    </div>
  );
}
