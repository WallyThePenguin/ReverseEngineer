// Today's "Needs you": every approval waiting for your yes or no, in full, on the inbox's own card.
// Several asking for the same kind of thing share an "Approve all" over every card it covers, each
// shown in full. It sends each yes in turn and says in one line how they went, never quietly.

import { createSignal, For, Show } from "solid-js";
import { ApprovalCard } from "../../components/ApprovalCard.tsx";
import { Icon } from "../../components/icons.tsx";
import { Card } from "../../components/kit/Card.tsx";
import { EmptyState } from "../../components/kit/EmptyState.tsx";
import { IconButton } from "../../components/kit/IconButton.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Skeleton } from "../../components/kit/Skeleton.tsx";
import { Button } from "../../components/ui.tsx";
import { type Decided, decide, deciding, isWaiting } from "../../lib/approvals.ts";
import { ago } from "../../lib/format.ts";
import { toast } from "../../lib/live.ts";
import { approvalCard, approveAllMessage, groupApprovals } from "../../lib/today.ts";
import { toolDoing } from "../../lib/toolNames.ts";
import type { Approval, InboxRow } from "../../lib/types.ts";

export function NeedsYou(props: {
  approvals: readonly Approval[];
  /** The inbox, whose cards name records by their titles. */
  inbox: readonly InboxRow[] | undefined;
}) {
  const [said, setSaid] = createSignal<{ text: string; ok: boolean } | null>(null);
  const [running, setRunning] = createSignal<string | null>(null);
  const groups = () => groupApprovals(props.approvals);
  // By kind, so a group keeps its place (and its cards) while the list refreshes under it.
  const kinds = () => groups().map((g) => g.action);
  const itemsOf = (action: string) => groups().find((g) => g.action === action)?.items ?? [];
  const waiting = (items: readonly Approval[]) =>
    items.filter((a) => isWaiting(a.id, a.status) && !deciding(a.id));

  const approveAll = async (action: string) => {
    const ids = waiting(itemsOf(action)).map((a) => a.id);
    setRunning(action);
    setSaid(null);
    const outcomes: Decided[] = [];
    try {
      // One at a time, as you'd press each: a send waits for the one before it.
      for (const id of ids) outcomes.push(await decide(id, "approve", { quiet: true }));
    } finally {
      setRunning(null);
      const result = approveAllMessage(outcomes);
      setSaid(result);
      toast.show(result.text, result.ok ? "info" : "error");
    }
  };

  const card = (a: Approval, open: boolean) => {
    const parts = () =>
      approvalCard(
        a,
        props.inbox?.find((r) => r.notification.approvalId === a.id),
      );
    return (
      <ApprovalCard
        approvalId={a.id}
        what={parts().what}
        why={parts().why}
        text={parts().text}
        status={a.status}
        byJarvis={a.requestedBy === "jarvis"}
        meta={`Asked ${ago(a.createdAt)}`}
        level={3}
        open={open}
      />
    );
  };

  return (
    <section aria-labelledby="today-needs" class="space-y-3">
      <SectionHeader id="today-needs" title="Needs you" count={props.approvals.length} />
      <Show when={said()}>
        {(s) => (
          <div
            role="status"
            class={`flex animate-enter items-center gap-2.5 rounded-lg py-1 pr-1 pl-3 text-sm ${s().ok ? "bg-ok-soft" : "bg-warn-soft"}`}
          >
            <Icon name={s().ok ? "ok" : "warn"} class={s().ok ? "text-ok" : "text-warn"} />
            <span class="min-w-0 flex-1">{s().text}</span>
            <IconButton icon="x" label="Dismiss" size={16} onClick={() => setSaid(null)} />
          </div>
        )}
      </Show>
      <For each={kinds()}>
        {(action) => (
          <Show
            when={itemsOf(action).length > 1}
            fallback={<For each={itemsOf(action)}>{(a) => card(a, false)}</For>}
          >
            <div class="space-y-2 rounded-xl bg-sunk p-2 ring-1 ring-line ring-inset">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 pr-1 pl-2">
                <p class="min-w-0 flex-1 text-sm">
                  <span class="font-medium">{toolDoing(action)}</span>
                  <span class="text-muted"> · {itemsOf(action).length} waiting</span>
                </p>
                <Show when={waiting(itemsOf(action)).length > 1 || running() === action}>
                  <Button
                    kind="primary"
                    small
                    icon="check"
                    disabled={running() !== null}
                    onClick={() => void approveAll(action)}
                  >
                    {running() === action
                      ? "Approving…"
                      : `Approve all ${waiting(itemsOf(action)).length}`}
                  </Button>
                </Show>
              </div>
              <For each={itemsOf(action)}>{(a) => card(a, true)}</For>
            </div>
          </Show>
        )}
      </For>
    </section>
  );
}

/** Nothing waits for your yes, and no draft waits to go: said calmly, as the good news it is. */
export function Clear() {
  return (
    <Card>
      <EmptyState icon="ok" title="You're clear" class="py-8">
        Nothing needs your yes right now. When Jarvis needs one, it'll be here, with what it would
        do in full.
      </EmptyState>
    </Card>
  );
}

/** Needs you, while the approvals are on their way. */
export function NeedsYouWaiting() {
  return (
    <section class="space-y-3">
      <SectionHeader title="Needs you" />
      <Card>
        <Skeleton kind="record" count={3} class="-m-4" />
      </Card>
    </section>
  );
}
