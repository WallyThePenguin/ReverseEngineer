// Updates (the inbox, at /inbox): Jarvis's results, approvals, due dates and alerts, split into
// Signal and Noise.
// j/k to move, Enter to open, e done, s snooze, a/d approve or deny. An approval waiting for
// you can't be put away with e, s or its menu: it needs a yes or a no. Each row is an InboxItem
// (inbox/InboxItem.tsx); an approval's is the shared ApprovalCard, its text in full.

import { createMemo, createSignal, For, Show } from "solid-js";
import { NoRows } from "../components/QueryView.tsx";
import { SetupChecklist } from "../components/SetupChecklist.tsx";
import { Empty, PaneHeader } from "../components/ui.tsx";
import { decide } from "../lib/approvals.ts";
import { snoozeOptions } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { type InboxView, NEEDS_DECISION, waitingOnYou } from "../lib/inbox.ts";
import { toast } from "../lib/live.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { act, inboxInput, useAction } from "../lib/query.ts";
import { createSelection } from "../lib/selection.ts";
import type { InboxRow } from "../lib/types.ts";
import { InboxItem } from "./inbox/InboxItem.tsx";

export function Inbox(props: { pane: number }) {
  const [view, setView] = createSignal<InboxView>("live");
  const [lane, setLane] = createSignal<"signal" | "noise">("signal");
  const [snoozing, setSnoozing] = createSignal<string | null>(null);
  const rows = useAction<InboxRow[]>("inbox.list", () => inboxInput(view(), lane()));
  const list = () => rows.data ?? [];
  // Kept by id: a new arrival above it doesn't move the keys onto a different row.
  const sel = createSelection(list, (r) => r.notification.id);
  // Rows are drawn by id too, not by object: a row read again after any change keeps its
  // element, so its open menu stays (on a phone, the next row's menu right after Done).
  const ids = createMemo(() => list().map((r) => r.notification.id));
  const byId = createMemo(() => new Map(list().map((row, i) => [row.notification.id, { row, i }])));
  const current = sel.current;
  const focused = () => layout.focused() === props.pane;

  const open = (row: InboxRow | undefined, beside = false) => {
    if (!row) return;
    const n = row.notification;
    if (n.state === "unseen") void act("inbox.mark", { ids: [n.id], state: "seen" });
    if (!n.entityId) return;
    const route = routeFor(row.entityType ?? "record", n.entityId);
    if (beside) layout.open(route, { beside: true });
    else layout.show(route, props.pane);
  };
  const done = (row: InboxRow | undefined) => {
    if (!row) return;
    if (waitingOnYou(row)) return toast.show(NEEDS_DECISION);
    void act("inbox.mark", {
      ids: [row.notification.id],
      state: view() === "done" ? "seen" : "done",
    });
  };
  const startSnooze = (row: InboxRow | undefined) => {
    if (waitingOnYou(row)) return toast.show(NEEDS_DECISION);
    setSnoozing(row?.notification.id ?? null);
  };
  const snooze = async (id: string, until: Date) => {
    setSnoozing(null);
    if (await act("inbox.snooze", { id, until: until.toISOString() })) toast.show("Snoozed.");
  };

  useHotkeys([
    ...listKeys({
      count: () => list().length,
      index: sel.index,
      setIndex: sel.select,
      when: focused,
    }),
    { keys: "enter", run: () => open(current()), when: focused, label: "Open" },
    { keys: "o", run: () => open(current()), when: focused },
    { keys: "e", run: () => done(current()), when: focused, label: "Done" },
    { keys: "s", run: () => startSnooze(current()), when: focused, label: "Snooze" },
    {
      keys: "a",
      run: () =>
        waitingOnYou(current()) && void decide(current()!.notification.approvalId!, "approve"),
      when: focused,
      label: "Approve",
    },
    {
      keys: "d",
      run: () =>
        waitingOnYou(current()) && void decide(current()!.notification.approvalId!, "deny"),
      when: focused,
      label: "Deny",
    },
    ...[1, 2, 3, 4].map((n) => ({
      keys: String(n),
      when: () => focused() && snoozing() !== null,
      run: () => {
        const opt = snoozeOptions()[n - 1];
        if (opt && snoozing()) void snooze(snoozing()!, opt.until);
      },
    })),
    { keys: "escape", run: () => setSnoozing(null), when: () => snoozing() !== null },
  ]);

  const pickLane = (l: "signal" | "noise") => {
    setLane(l);
    sel.reset();
  };
  const tab = (active: boolean) =>
    `min-h-11 rounded-md px-2 py-1 text-sm md:min-h-0 ${active ? "bg-sunk font-medium" : "text-muted hover:text-ink"}`;

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Updates">
        <Show when={view() === "live"}>
          <button type="button" class={tab(lane() === "signal")} onClick={() => pickLane("signal")}>
            Signal
          </button>
          <button type="button" class={tab(lane() === "noise")} onClick={() => pickLane("noise")}>
            Noise
          </button>
          <span class="mx-1 h-4 w-px bg-line" />
        </Show>
        <select
          class="min-h-11 rounded-md border border-line bg-panel px-2 py-1 text-sm md:min-h-0"
          aria-label="Which items"
          value={view()}
          onChange={(e) => {
            setView(e.currentTarget.value as InboxView);
            sel.reset();
          }}
        >
          <option value="live">Live</option>
          <option value="snoozed">Snoozed</option>
          <option value="done">Done</option>
        </select>
      </PaneHeader>
      <div class="flex-1 overflow-auto">
        <Show
          when={rows.data !== undefined}
          fallback={
            <NoRows query={rows} what="your updates">
              {null}
            </NoRows>
          }
        >
          <Show
            when={list().length > 0}
            fallback={
              <>
                <Show when={view() === "live"}>
                  <SetupChecklist pane={props.pane} />
                </Show>
                <Empty>
                  {view() === "live"
                    ? "Nothing needs you. Pip will put things here."
                    : "Nothing here."}
                </Empty>
              </>
            }
          >
            <ul>
              <For each={ids()}>
                {(id) => {
                  let last = byId().get(id)!;
                  const at = () => (last = byId().get(id) ?? last);
                  const row = () => at().row;
                  const i = () => at().i;
                  return (
                    <InboxItem
                      row={row()}
                      view={view()}
                      active={focused() && i() === sel.index()}
                      snoozing={snoozing() === id}
                      onSelect={() => sel.select(i())}
                      onOpen={(beside) => {
                        sel.select(i());
                        open(row(), beside);
                      }}
                      onDone={() => done(row())}
                      onSnooze={() => startSnooze(row())}
                      onSnoozeUntil={(until) => snooze(id, until)}
                    />
                  );
                }}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </div>
  );
}
