// Today's "Needs you": every approval waiting for your yes or no, one line each, so the morning fits
// on one screen. A send says who it goes to by name and its subject, and opens in place to exactly
// what a yes would send (the addresses in full, anyone new in red, every word) with Deny and
// Approve under it: a yes never covers words you haven't seen (D33, D58). One whose line is all
// there is to it (an invitation, say) has its yes on the line. Hearth's usual reason is said once
// over the list; any other stays on its row. Several asking for the same kind of thing share an
// "Approve all", which first opens them ("Read all 3") and then sits under the last of them, so
// reaching it means passing every one. It covers only rows that have been open and listed a
// moment, so one that arrives or opens just before a tap waits for you to look. A send
// that would reach someone who isn't in its conversation (or a new email) is approved on its own.
// "Approve all" sends each yes in turn and says how they went in one place, which stays after the
// rows have gone.

import { createMemo, createSignal, For, type JSX, Show, untrack } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { Card } from "../../components/kit/Card.tsx";
import { EmptyState } from "../../components/kit/EmptyState.tsx";
import { IconButton } from "../../components/kit/IconButton.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Skeleton } from "../../components/kit/Skeleton.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { Button, Failed } from "../../components/ui.tsx";
import { decideQuietly, deciding, isWaiting } from "../../lib/approvals.ts";
import {
  type ApproveAllResult,
  type ApprovedItem,
  approvalCard,
  approveAllResult,
  askRow,
  coverable,
  groupApprovals,
  type Reach,
  sendDraftId,
  sendReach,
} from "../../lib/needsYou.ts";
import { useActions } from "../../lib/query.ts";
import { createSettled, noneNew, sameIds } from "../../lib/settled.ts";
import { toolDoing } from "../../lib/toolNames.ts";
import type { Approval, InboxRow, MailDraft, MailThreadView } from "../../lib/types.ts";
import { AskRow } from "./AskRow.tsx";
import type { Go } from "./parts.tsx";

/** "Approve all", kept by Today so what it says outlives the rows it covered. */
export interface ApproveAll {
  /** The group being approved, if one is. */
  running: () => string | null;
  run: (group: string, items: readonly Approval[]) => Promise<void>;
  result: () => ApproveAllResult | null;
  dismiss: () => void;
}

export function useApproveAll(): ApproveAll {
  const [running, setRunning] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<ApproveAllResult | null>(null);
  const run = async (group: string, items: readonly Approval[]) => {
    if (running() || !items.length) return;
    setRunning(group);
    setResult(null);
    const told: ApprovedItem[] = [];
    try {
      // One at a time, as you'd press each: a send waits for the one before it.
      for (const a of items) told.push({ approval: a, ...(await decideQuietly(a.id, "approve")) });
    } finally {
      setRunning(null);
      setResult(approveAllResult(told));
    }
  };
  return { running, run, result, dismiss: () => setResult(null) };
}

export function NeedsYou(props: {
  approvals: readonly Approval[];
  /** The inbox, whose cards name records by their titles. */
  inbox: readonly InboxRow[] | undefined;
  /** Every draft, to tell who a send would reach. */
  drafts: readonly MailDraft[] | undefined;
  approving: ApproveAll;
  /**
   * Whether this is the first showing since Today opened (asking marks it shown). Those are what
   * Today opened on; shown again after the list was empty, they've only just come, and Approve
   * all waits a moment before covering them.
   */
  opening: () => boolean;
  go: Go;
}) {
  // The approvals on screen a moment, wherever they are in the list: what Approve all may cover.
  // One that just came (below the fold, say) waits for a look; one that only moved into a group,
  // once its recipients were checked, was on screen already.
  const onScreen = createSettled(() => props.approvals.map((a) => a.id), {
    same: sameIds,
    safe: noneNew,
    ...(untrack(props.opening) ? {} : { initial: [] as string[] }),
  });
  // The rows you've opened, by approval: kept here, so a row that moves into a group stays open.
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const openAll = (ids: readonly string[]) => setOpen((s) => new Set([...s, ...ids]));
  const inboxOf = (a: Approval) => props.inbox?.find((r) => r.notification.approvalId === a.id);
  // A row whose line is all there is to it doesn't open: it's read as it stands.
  const read = createMemo<ReadonlySet<string>>(() => {
    const whole = props.approvals.filter((a) => askRow(a, approvalCard(a, inboxOf(a)), null).whole);
    return new Set([...open(), ...whole.map((a) => a.id)]);
  });

  const draftOf = (a: Approval) => props.drafts?.find((d) => d.id === sendDraftId(a));
  // The conversations the sends answer, read as a draft's row reads them (the same cache).
  const threadIds = createMemo(
    () => [
      ...new Set(
        props.approvals.flatMap((a) => {
          const t = a.action === "mail.send" ? draftOf(a)?.threadId : null;
          return t ? [t] : [];
        }),
      ),
    ],
    [],
    { equals: sameIds },
  );
  const threads = useActions<MailThreadView>("mail.thread", () =>
    threadIds().map((id) => ({ id })),
  );
  const thread = (id: string) => threads[threadIds().indexOf(id)]?.data;
  const reach = (a: Approval): Reach | null =>
    a.action === "mail.send" ? sendReach(a, props.drafts, thread) : null;
  // A send to someone new, a new email, or one not checked yet is approved on its own.
  const groups = createMemo(() =>
    groupApprovals(props.approvals, (a) => {
      const r = reach(a);
      return r !== null && !coverable(r);
    }),
  );
  const keys = () => groups().map((g) => g.key);
  const itemsOf = (key: string) => groups().find((g) => g.key === key)?.items ?? [];

  const row = (a: Approval) => (
    <AskRow
      approval={a}
      inbox={inboxOf(a)}
      draft={draftOf(a)}
      reach={reach(a)}
      checking={!!draftOf(a) || !props.drafts}
      open={open().has(a.id)}
      onToggle={() => toggle(a.id)}
      go={props.go}
    />
  );

  return (
    <section aria-labelledby="today-needs" data-jump="today-needs" class="scroll-mt-4 space-y-2">
      <div>
        <SectionHeader id="today-needs" title="Needs you" count={props.approvals.length} />
        <p class="text-meta text-muted">Nothing happens until you say yes.</p>
      </div>
      <Card flush>
        <For each={keys()}>
          {(key) => (
            <div class="border-b border-line last:border-b-0">
              <Group
                group={key}
                action={itemsOf(key)[0]?.action ?? key}
                items={itemsOf(key)}
                row={row}
                approving={props.approving}
                seen={onScreen.armed()}
                open={read()}
                openAll={openAll}
              />
            </div>
          )}
        </For>
      </Card>
    </section>
  );
}

/** Approvals of one kind: each alone, or under one "Approve all" when there are several. */
function Group(props: {
  group: string;
  action: string;
  items: readonly Approval[];
  row: (a: Approval) => JSX.Element;
  approving: ApproveAll;
  /** The approvals on screen a moment. */
  seen: readonly string[];
  /** The rows you've opened, and those that show all of themselves on their line. */
  open: ReadonlySet<string>;
  openAll: (ids: readonly string[]) => void;
}) {
  const live = () =>
    props.items.filter((a) => isWaiting(a.id, a.status) && !deciding(a.id)).map((a) => a.id);
  // The rows open a moment: opening them all is a change Approve all waits out, like an arrival.
  const shown = createSettled(() => live().filter((id) => props.open.has(id)), {
    same: sameIds,
    safe: noneNew,
    initial: [],
  });
  const closed = () => live().filter((id) => !props.open.has(id));
  // One that just arrived waits for a look, open or not.
  const arrived = () => live().filter((id) => !props.seen.includes(id)).length;
  // What a tap covers: rows open and listed a moment, all above the button.
  const covered = () =>
    live().filter((id) => props.seen.includes(id) && shown.armed().includes(id));
  const running = () => props.approving.running() === props.group;
  const approveAll = () => {
    if (arrived() > 0 || covered().length < live().length) return;
    const c = covered();
    void props.approving.run(
      props.group,
      props.items.filter((a) => c.includes(a.id)),
    );
  };
  const rows = () => (
    <ul>
      <For each={props.items}>{(a) => props.row(a)}</For>
    </ul>
  );
  const several = () => live().length > 1 || running();
  // All read: the yes goes under the last row, so reaching it means passing every one of them.
  const allRead = () => several() && (closed().length === 0 || running());
  return (
    <Show when={props.items.length > 1} fallback={rows()}>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-sunk/50 py-1.5 pr-2 pl-3">
        {/* Never squeezed: narrow, the button goes under it. */}
        <p class="min-w-40 flex-1 text-meta">
          <span class="font-medium">{toolDoing(props.action)}</span>
          <span class="text-muted"> · {props.items.length} waiting</span>
        </p>
        <Show when={several() && !allRead()}>
          <Button small icon="chevron-down" onClick={() => props.openAll(closed())}>
            {`Read all ${live().length}`}
          </Button>
        </Show>
      </div>
      {rows()}
      <Show when={allRead()}>
        <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-t border-line bg-sunk/50 py-1.5 pr-2 pl-3">
          <Show when={arrived() > 0}>
            <p role="status" class="flex flex-1 items-center gap-1 text-meta font-medium text-warn">
              <Icon name="warn" size={14} />
              {`${arrived()} new — look again`}
            </p>
          </Show>
          <Button
            kind="primary"
            small
            icon="check"
            disabled={
              props.approving.running() !== null ||
              arrived() > 0 ||
              covered().length < live().length
            }
            onClick={approveAll}
          >
            {running() ? "Approving…" : `Approve all ${live().length}`}
          </Button>
        </div>
      </Show>
    </Show>
  );
}

/** What "Approve all" did, over Needs you: kept until you close it, even once the rows are gone. */
export function ApproveAllSaid(props: { approving: ApproveAll; ready: ReadonlySet<string> }) {
  return (
    <Show when={props.approving.result()}>
      {(r) => (
        <div
          role="status"
          class={`animate-enter rounded-lg py-1 pr-1 pl-3 text-sm ${r().ok ? "bg-ok-soft" : "bg-warn-soft"}`}
        >
          <div class="flex items-center gap-2.5">
            <Icon name={r().ok ? "ok" : "warn"} class={r().ok ? "text-ok" : "text-warn"} />
            <p class="min-w-0 flex-1 font-medium">{r().text}</p>
            <IconButton icon="x" label="Dismiss" size={16} onClick={props.approving.dismiss} />
          </div>
          <Show when={r().missed.length > 0}>
            <ul class="space-y-1 pr-3 pb-2 pl-7">
              <For each={r().missed}>
                {(m) => (
                  <li>
                    <span class="font-medium">{m.label}</span>
                    {` — ${m.why}`}
                    {m.draftId && props.ready.has(m.draftId) ? " It's in Ready to send." : ""}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      )}
    </Show>
  );
}

/** Nothing waits for your yes, and no draft waits to go: said calmly, as the good news it is. */
export function Clear() {
  return (
    <Card>
      <EmptyState icon="ok" title="You're all caught up" class="py-8">
        Nothing needs your yes right now. When Pip needs one, it'll be here, with exactly what it
        would do.
      </EmptyState>
    </Card>
  );
}

/** Needs you, while the approvals are on their way, or with Try again when they couldn't be read. */
export function NeedsYouWaiting(props: { query: QueryRead<unknown> }) {
  return (
    <section class="space-y-3">
      <SectionHeader title="Needs you" />
      <Card flush>
        <Show when={props.query.isError} fallback={<Skeleton kind="record" count={3} />}>
          <Failed
            error={props.query.error}
            retry={props.query.refetch}
            what="what needs your yes"
          />
        </Show>
      </Card>
    </section>
  );
}
