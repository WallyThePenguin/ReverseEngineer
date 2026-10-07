// Today's brief, at the top: the newest one Jarvis wrote, in full until you've read it, then folded
// to its first line, which opens it again; on a phone it's that one line from the start, so what
// needs you stays on the first screen. It can quote your mail, so where it was written after
// reading outside content it carries that mark (D58). A long one shows its start with "Read all".

import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { Body } from "../../components/Body.tsx";
import { Icon } from "../../components/icons.tsx";
import { Button } from "../../components/kit/Button.tsx";
import { Card } from "../../components/kit/Card.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Skeleton } from "../../components/kit/Skeleton.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import { day, time } from "../../lib/format.ts";
import { routeFor } from "../../lib/panes.ts";
import { act, useAction } from "../../lib/query.ts";
import { unmark } from "../../lib/turns.ts";
import type { Entity, InboxRow } from "../../lib/types.ts";
import type { Go } from "./parts.tsx";

/** "7:30 a.m.", or "yesterday, 7:30 a.m." for one that isn't today's. */
const written = (iso: string) => {
  const d = new Date(iso);
  const on = day(d);
  return on === "today" ? time(d) : `${on}, ${time(d)}`;
};

export function Brief(props: { row: InboxRow; go: Go; class?: string }) {
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
    setReadHere(true);
    if (n().state === "unseen") void act("inbox.mark", { ids: [n().id], state: "seen" });
    if (n().entityId) props.go(routeFor("brief", n().entityId!), beside);
  };
  // Read once you've opened it or said you have ("Got it"): then it folds to its first line.
  const [readHere, setReadHere] = createSignal(false);
  const read = () => readHere() || n().state !== "unseen";
  const [unfolded, setUnfolded] = createSignal(false);
  const gotIt = () => {
    setReadHere(true);
    setUnfolded(false);
    if (n().state === "unseen") void act("inbox.mark", { ids: [n().id], state: "seen" });
  };
  const headline = () => body().split("\n").map(unmark).find(Boolean) ?? "Your brief";
  // Cut short where it's taller than the box; "Read all" shows the rest.
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
    <section aria-labelledby={id} class={`scroll-mt-4 space-y-3 ${props.class ?? ""}`}>
      <SectionHeader
        id={id}
        title="Your brief"
        more={n().entityId ? { label: "Open", run: () => open(false) } : undefined}
      />
      {/* One line: once read, everywhere; while new, where Today is one column (a phone), so what
          needs you stays on the first screen. */}
      <Show when={!unfolded()}>
        <Card flush class={read() ? "" : "@4xl:hidden"}>
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-[inherit] px-4 py-3 text-left hover:bg-sunk/60"
            aria-expanded="false"
            onClick={() => setUnfolded(true)}
          >
            <JarvisMark size={16} />
            <span class="min-w-0 flex-1">
              <span class={`block truncate text-sm ${read() ? "" : "font-semibold"}`}>
                {headline()}
              </span>
              <span class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-muted">
                <Show when={!read()}>
                  <span class="font-medium text-accent">New</span>
                  <span aria-hidden="true">·</span>
                </Show>
                {`Jarvis · ${written(n().createdAt)}`}
                <Show when={outside()}>
                  <OutsideMark>Quotes outside content</OutsideMark>
                </Show>
              </span>
            </span>
            <Icon name="chevron-down" size={16} class="text-faint" />
          </button>
        </Card>
      </Show>
      <Show when={unfolded() || !read()}>
        <Card class={unfolded() ? "" : "hidden @4xl:block"}>
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
            <div ref={watch} class={`relative mt-3 ${whole() ? "" : "max-h-44 overflow-hidden"}`}>
              <Body text={body()} class="text-sm" />
              <Show when={long() && !whole()}>
                <div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-raised" />
              </Show>
            </div>
            <div class="-mb-1 mt-2 flex items-center">
              <Show when={long() && !whole()}>
                <button
                  type="button"
                  class="inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-accent hover:underline md:min-h-8"
                  onClick={() => setWhole(true)}
                >
                  Read all
                </button>
              </Show>
              <span class="flex-1" />
              <Show
                when={!read()}
                fallback={
                  <Button kind="quiet" small onClick={() => setUnfolded(false)}>
                    Fold
                  </Button>
                }
              >
                <Button kind="quiet" small icon="check" onClick={gotIt}>
                  Got it
                </Button>
              </Show>
            </div>
          </Show>
        </Card>
      </Show>
    </section>
  );
}
