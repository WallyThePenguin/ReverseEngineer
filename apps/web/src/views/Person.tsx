// A person's page: how to reach them, their company, when you last talked, a follow-up if you
// want one, your own fields, and everything linked to them. And a company's page: its people.

import { createSignal, For, type JSX, Show } from "solid-js";
import { Overflow, ROW_MENU } from "../components/Menu.tsx";
import { Empty } from "../components/ui.tsx";
import { ago, day, TYPE_LABEL } from "../lib/format.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { moveToTrash } from "../lib/trash.ts";
import type { CompanyDetail, LastContact, Linked, Person, PersonDetail } from "../lib/types.ts";

const FOLLOW_UP = [
  { days: 0, label: "No reminder" },
  { days: 14, label: "Every 2 weeks" },
  { days: 30, label: "Every month" },
  { days: 60, label: "Every 2 months" },
  { days: 90, label: "Every 3 months" },
  { days: 180, label: "Every 6 months" },
  { days: 365, label: "Every year" },
];

/** "Last talked 3 days ago, by email." */
export function talked(l: LastContact | null): string {
  if (!l) return "No email or meeting yet";
  return `Last talked ${ago(l.at)}, ${l.kind === "email" ? "by email" : "in a meeting"}`;
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div>
      <h3 class="mb-1 text-xs font-medium uppercase tracking-wide text-faint">{props.title}</h3>
      {props.children}
    </div>
  );
}

function Items(props: { title: string; rows: Linked[]; detail?: (l: Linked) => string }) {
  return (
    <Show when={props.rows.length > 0}>
      <Section title={props.title}>
        <ul class="space-y-0.5">
          <For each={props.rows}>
            {(l) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-sunk"
                  onClick={(e) => layout.open(routeFor(l.type, l.id), { beside: e.shiftKey })}
                >
                  <span class="w-16 shrink-0 text-xs text-faint">
                    {TYPE_LABEL[l.type] ?? l.type}
                  </span>
                  <span class="flex-1 truncate">{l.title || "Untitled"}</span>
                  <span class="shrink-0 text-xs text-faint">
                    {props.detail ? props.detail(l) : day(new Date(l.at))}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Section>
    </Show>
  );
}

function Fields(props: { id: string; fields: Record<string, string> }) {
  const [key, setKey] = createSignal("");
  const [value, setValue] = createSignal("");
  const save = (fields: Record<string, string>) => act("person.update", { id: props.id, fields });
  return (
    <Section title="Fields">
      <ul class="space-y-0.5 text-sm">
        <For each={Object.entries(props.fields)}>
          {([k, v]) => (
            <li class="group flex gap-2 px-2">
              <span class="w-28 shrink-0 text-muted">{k}</span>
              <span class="flex-1 whitespace-pre-wrap">{v}</span>
              <button
                type="button"
                class="text-faint opacity-0 group-hover:opacity-100"
                title="Remove"
                onClick={() => {
                  const { [k]: _gone, ...rest } = props.fields;
                  void save(rest);
                }}
              >
                ×
              </button>
            </li>
          )}
        </For>
      </ul>
      <form
        class="mt-1 flex gap-2 px-2 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!key().trim()) return;
          if (await save({ ...props.fields, [key().trim()]: value() })) {
            setKey("");
            setValue("");
          }
        }}
      >
        <input
          class="w-28 bg-transparent outline-none placeholder:text-faint"
          placeholder="Add a field…"
          value={key()}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <input
          class="flex-1 bg-transparent outline-none placeholder:text-faint"
          placeholder="Value"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      </form>
    </Section>
  );
}

export function PersonPanel(props: { id: string }) {
  const p = useAction<PersonDetail>("person.view", () => ({ id: props.id }));
  return (
    <Show when={p.data}>
      {(v) => (
        <div class="space-y-5">
          <div class="space-y-1 rounded-md bg-sunk px-3 py-3 text-sm">
            <Show when={v().emails.length > 0}>
              <p>
                <For each={v().emails}>
                  {(e, i) => (
                    <>
                      {i() > 0 ? ", " : ""}
                      <a class="text-jarvis underline" href={`mailto:${encodeURIComponent(e)}`}>
                        {e}
                      </a>
                    </>
                  )}
                </For>
              </p>
            </Show>
            <Show when={v().company}>
              {(c) => (
                <p>
                  Works at{" "}
                  <button
                    type="button"
                    class="text-jarvis underline"
                    onClick={(e) =>
                      layout.open(routeFor("company", c().id), { beside: e.shiftKey })
                    }
                  >
                    {c().name}
                  </button>
                </p>
              )}
            </Show>
            <p class="text-muted">
              {talked(v().lastContact)}
              <Show when={v().overdueDays}>
                <span class="text-warn"> · time to get in touch</span>
              </Show>
            </p>
            <label class="flex items-center gap-2 pt-1 text-muted">
              Remind me
              <select
                class="rounded bg-panel px-1 py-0.5"
                value={v().followUpDays ?? 0}
                onChange={(e) => {
                  const days = Number(e.currentTarget.value);
                  void act("person.follow_up", { id: v().id, days: days || null });
                }}
              >
                <Show
                  when={v().followUpDays && !FOLLOW_UP.some((f) => f.days === v().followUpDays)}
                >
                  <option value={v().followUpDays ?? 0}>Every {v().followUpDays} days</option>
                </Show>
                <For each={FOLLOW_UP}>{(f) => <option value={f.days}>{f.label}</option>}</For>
              </select>
              <span class="text-faint">if we haven't talked</span>
            </label>
          </div>
          <Fields id={v().id} fields={v().fields} />
          <Items title="Coming up" rows={v().upcoming} />
          <Items
            title="Email"
            rows={v().threads}
            detail={(l) => {
              const n = v().threads.find((t) => t.id === l.id)?.messages ?? 0;
              return `${n} message${n === 1 ? "" : "s"} · ${day(new Date(l.at))}`;
            }}
          />
          <Items title="Meetings" rows={v().met} />
          <Items title="Linked" rows={v().items} />
        </div>
      )}
    </Show>
  );
}

export function PeopleRows(props: {
  rows: Person[];
  active?: number;
  onOpen: (p: Person) => void;
}) {
  return (
    <ul>
      <For each={props.rows}>
        {(p, i) => (
          <li
            class="group flex cursor-pointer items-center gap-3 border-b border-line py-1 pr-2 pl-4 md:py-2"
            data-active={i() === props.active}
            onClick={() => props.onOpen(p)}
          >
            <span class="truncate">{p.name}</span>
            <span class="flex-1 truncate text-xs text-faint">{p.company ?? ""}</span>
            <Show when={p.overdueDays}>
              <span class="text-xs text-warn">get in touch</span>
            </Show>
            <span class="text-xs text-faint">{p.lastContact ? ago(p.lastContact.at) : ""}</span>
            <Overflow
              class={ROW_MENU}
              label={`Actions for ${p.name}`}
              items={[{ label: "Move to trash", danger: true, run: () => void moveToTrash(p.id) }]}
            />
          </li>
        )}
      </For>
    </ul>
  );
}

export function CompanyPanel(props: { id: string }) {
  const c = useAction<CompanyDetail>("company.view", () => ({ id: props.id }));
  return (
    <Show when={c.data}>
      {(v) => (
        <div class="space-y-3">
          <p class="text-sm text-muted">{v().domain}</p>
          <Section title="People">
            <Show when={v().people.length > 0} fallback={<Empty>No one yet.</Empty>}>
              <PeopleRows
                rows={v().people}
                onOpen={(p) => layout.open(routeFor("person", p.id), {})}
              />
            </Show>
          </Section>
        </div>
      )}
    </Show>
  );
}
