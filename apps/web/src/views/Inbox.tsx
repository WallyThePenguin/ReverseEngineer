// One inbox: Jarvis's results, approvals, due dates and alerts, split into Signal and Noise.
// j/k to move, Enter to open, e done, s snooze, a/d approve or deny. An approval waiting for
// you can't be put away with e or s: it needs a yes or a no.

import { createSignal, For, Match, Show, Switch } from "solid-js";
import { Body } from "../components/Body.tsx";
import { Badge, Button, Empty, Kbd, PaneHeader } from "../components/ui.tsx";
import { approvalStateText, decide, deciding, isDecided } from "../lib/approvals.ts";
import { ago, due, snoozeOptions, who } from "../lib/format.ts";
import { listKeys, useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { layout, routeFor } from "../lib/panes.ts";
import { act, inboxInput, useAction } from "../lib/query.ts";
import type { InboxRow } from "../lib/types.ts";

type View = "live" | "snoozed" | "done";

/** An approval card still waiting for your yes or no (and not decided here a moment ago). */
const waitingOnYou = (row: InboxRow | undefined) =>
  !!row?.notification.approvalId &&
  row.approvalStatus === "pending" &&
  !isDecided(row.notification.approvalId);
const NEEDS_DECISION = "This one needs a yes or a no first: press a or d.";

export function Inbox(props: { pane: number }) {
  const [view, setView] = createSignal<View>("live");
  const [lane, setLane] = createSignal<"signal" | "noise">("signal");
  const [index, setIndex] = createSignal(0);
  const [snoozing, setSnoozing] = createSignal<string | null>(null);
  const rows = useAction<InboxRow[]>("inbox.list", () => inboxInput(view(), lane()));
  const list = () => rows.data ?? [];
  const current = () => list()[Math.min(index(), list().length - 1)];
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
    ...listKeys({ count: () => list().length, index, setIndex, when: focused }),
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

  const tab = (active: boolean) =>
    `rounded-md px-2 py-1 text-sm ${active ? "bg-sunk font-medium" : "text-muted hover:text-ink"}`;

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Inbox">
        <Show when={view() === "live"}>
          <button type="button" class={tab(lane() === "signal")} onClick={() => setLane("signal")}>
            Signal
          </button>
          <button type="button" class={tab(lane() === "noise")} onClick={() => setLane("noise")}>
            Noise
          </button>
          <span class="mx-1 h-4 w-px bg-line" />
        </Show>
        <select
          class="rounded-md border border-line bg-panel px-2 py-1 text-sm"
          value={view()}
          onChange={(e) => {
            setView(e.currentTarget.value as View);
            setIndex(0);
          }}
        >
          <option value="live">Live</option>
          <option value="snoozed">Snoozed</option>
          <option value="done">Done</option>
        </select>
      </PaneHeader>
      <div class="flex-1 overflow-auto">
        <Show when={!rows.isLoading} fallback={<Empty>Loading…</Empty>}>
          <Show
            when={list().length > 0}
            fallback={
              <Empty>
                {view() === "live"
                  ? "Nothing needs you. Jarvis will put things here."
                  : "Nothing here."}
              </Empty>
            }
          >
            <ul>
              <For each={list()}>
                {(row, i) => {
                  const n = row.notification;
                  const deadline = () => due(n.deadline, false);
                  return (
                    <li
                      class="cursor-pointer border-b border-line px-4 py-3"
                      data-active={focused() && i() === index()}
                      onClick={(e) => {
                        setIndex(i());
                        open(row, e.shiftKey);
                      }}
                    >
                      <div class="flex items-start gap-3">
                        <span
                          class={`mt-1.5 size-2 shrink-0 rounded-full ${n.state === "unseen" ? "bg-accent" : "bg-transparent"}`}
                        />
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class={`truncate ${n.state === "unseen" ? "font-semibold" : ""}`}>
                              {n.title}
                            </span>
                            <Show when={n.urgency === "interrupt"}>
                              <Badge tone="bad">Urgent</Badge>
                            </Show>
                            <Show when={n.kind === "brief"}>
                              <Badge tone="jarvis">Brief</Badge>
                            </Show>
                          </div>
                          <Show when={n.body && n.kind !== "brief"}>
                            <Show
                              when={waitingOnYou(row)}
                              fallback={
                                <div class="mt-0.5 line-clamp-3 text-sm text-muted">
                                  <Body text={n.body} />
                                </div>
                              }
                            >
                              {/* Exactly what would happen, as plain text and in full. */}
                              <pre class="mt-1 max-h-96 overflow-auto rounded bg-sunk p-2 font-sans text-sm whitespace-pre-wrap">
                                {n.body}
                              </pre>
                            </Show>
                          </Show>
                          <Switch>
                            <Match when={waitingOnYou(row)}>
                              <div class="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
                                <Button
                                  kind="primary"
                                  small
                                  disabled={deciding(n.approvalId!)}
                                  onClick={() => decide(n.approvalId!, "approve")}
                                >
                                  Approve <Kbd>a</Kbd>
                                </Button>
                                <Button
                                  kind="danger"
                                  small
                                  disabled={deciding(n.approvalId!)}
                                  onClick={() => decide(n.approvalId!, "deny")}
                                >
                                  Deny <Kbd>d</Kbd>
                                </Button>
                              </div>
                            </Match>
                            <Match when={n.approvalId && row.approvalStatus}>
                              <p class="mt-1 text-xs text-muted">
                                {approvalStateText(row.approvalStatus!)}
                              </p>
                            </Match>
                          </Switch>
                          <Show when={snoozing() === n.id}>
                            <div
                              class="mt-2 flex flex-wrap gap-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <For each={snoozeOptions()}>
                                {(o, j) => (
                                  <Button small onClick={() => snooze(n.id, o.until)}>
                                    <Kbd>{j() + 1}</Kbd> {o.label}
                                  </Button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                        <div class="shrink-0 text-right text-xs text-faint">
                          <div>{ago(n.createdAt)}</div>
                          <Show when={n.createdBy !== "owner"}>
                            <div>{who(n.createdBy)}</div>
                          </Show>
                          <Show when={deadline()}>
                            <div class={deadline()!.overdue ? "text-bad" : "text-warn"}>
                              due {deadline()!.text}
                            </div>
                          </Show>
                        </div>
                      </div>
                    </li>
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
