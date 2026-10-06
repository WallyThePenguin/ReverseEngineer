// Today's brief: the newest one Jarvis wrote, in full, as its record has it. It can quote your
// mail, so where it was written after reading outside content it carries that mark (D58). Where
// Today is one column (a phone), a long one shows its start with "Read all", so your day and what's
// due aren't pages further down.

import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { Body } from "../../components/Body.tsx";
import { Card } from "../../components/kit/Card.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Skeleton } from "../../components/kit/Skeleton.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import { day, time } from "../../lib/format.ts";
import { routeFor } from "../../lib/panes.ts";
import { act, useAction } from "../../lib/query.ts";
import type { Entity, InboxRow } from "../../lib/types.ts";
import type { Go } from "./parts.tsx";

/** "7:30 a.m.", or "yesterday, 7:30 a.m." for one that isn't today's. */
const written = (iso: string) => {
  const d = new Date(iso);
  const on = day(d);
  return on === "today" ? time(d) : `${on}, ${time(d)}`;
};

export function Brief(props: { row: InboxRow; go: Go }) {
  const id = createUniqueId();
  const n = () => props.row.notification;
  const rec = useAction<Entity>(
    "entity.get",
    () => ({ id: n().entityId }),
    () => !!n().entityId,
  );
  const body = () => (n().entityId ? rec.data?.body : n().body) ?? "";
  // Written by a turn that had read outside content, or by an outside tool.
  const outside = () =>
    !!rec.data &&
    (rec.data.outside === true ||
      rec.data.createdBy.startsWith("integration:") ||
      rec.data.createdBy.startsWith("mcp:"));
  const open = (beside: boolean) => {
    if (n().state === "unseen") void act("inbox.mark", { ids: [n().id], state: "seen" });
    if (n().entityId) props.go(routeFor("brief", n().entityId!), beside);
  };
  // Cut short only where it's one column and taller than the box; "Read all" shows the rest.
  const [whole, setWhole] = createSignal(false);
  const [long, setLong] = createSignal(false);
  // Watched from when the text is drawn (it waits for the record): taller than its box, or not.
  const watch = (box: HTMLDivElement) => {
    if (typeof ResizeObserver === "undefined") return;
    const measure = new ResizeObserver(() => setLong(box.scrollHeight > box.clientHeight + 8));
    measure.observe(box);
    queueMicrotask(() => box.firstElementChild && measure.observe(box.firstElementChild));
    onCleanup(() => measure.disconnect());
  };
  return (
    <section aria-labelledby={id} class="scroll-mt-4 space-y-3">
      <SectionHeader
        id={id}
        title="Your brief"
        more={n().entityId ? { label: "Open", run: () => open(false) } : undefined}
      />
      <Card>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <JarvisMark size={16} />
          <p class="min-w-0 flex-1 text-meta text-muted">
            {/* Its title ("Brief for 2026-10-05") says less than when it was written. */}
            <span class="font-medium text-ink">Jarvis</span>
            {` · ${written(n().createdAt)}`}
          </p>
          <Show when={outside()}>
            <OutsideMark>Quotes outside content</OutsideMark>
          </Show>
        </div>
        <Show
          when={!n().entityId || rec.data}
          fallback={<Skeleton kind="record" count={4} class="-mx-4 -mb-4" />}
        >
          <div
            ref={watch}
            class={`relative mt-3 ${whole() ? "" : "max-h-80 overflow-hidden @4xl:max-h-none @4xl:overflow-visible"}`}
          >
            <Body text={body()} class="text-sm" />
            <Show when={long() && !whole()}>
              <div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-raised @4xl:hidden" />
            </Show>
          </div>
          <Show when={long() && !whole()}>
            <button
              type="button"
              class="-mb-1 mt-2 inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-accent hover:underline md:min-h-8 @4xl:hidden"
              onClick={() => setWhole(true)}
            >
              Read all
            </button>
          </Show>
        </Show>
      </Card>
    </section>
  );
}
