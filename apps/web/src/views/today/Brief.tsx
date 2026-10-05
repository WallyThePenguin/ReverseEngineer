// Today's brief: the newest one Jarvis wrote, in full, as its record has it. It can quote your
// mail, so where it was written after reading outside content it carries that mark (D58).

import { createUniqueId, Show } from "solid-js";
import { Body } from "../../components/Body.tsx";
import { Card } from "../../components/kit/Card.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Skeleton } from "../../components/kit/Skeleton.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import { day, time } from "../../lib/format.ts";
import { layout, routeFor } from "../../lib/panes.ts";
import { act, useAction } from "../../lib/query.ts";
import type { Entity, InboxRow } from "../../lib/types.ts";

/** "7:30 a.m.", or "yesterday, 7:30 a.m." for one that isn't today's. */
const written = (iso: string) => {
  const d = new Date(iso);
  const on = day(d);
  return on === "today" ? time(d) : `${on}, ${time(d)}`;
};

export function Brief(props: { row: InboxRow }) {
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
    if (n().entityId) layout.open(routeFor("brief", n().entityId!), { beside });
  };
  return (
    <section aria-labelledby={id} class="space-y-3">
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
          <Body text={body()} class="mt-3 text-sm" />
        </Show>
      </Card>
    </section>
  );
}
