// Today's "Needs you": every approval waiting for your yes or no, in full, on the inbox's own card.
// Several asking for the same kind of thing share an "Approve all" over every card it covers, each
// shown in full; it covers only cards that have been on screen a moment, so one that arrives just
// before a tap waits for you to look again. A send that would reach someone who isn't in its
// conversation (or a new email) says so in red and is approved on its own. "Approve all" sends
// each yes in turn and says how they went in one place, which stays after the cards have gone.

import { createMemo, createSignal, For, type JSX, Show, untrack } from "solid-js";
import { ApprovalCard } from "../../components/ApprovalCard.tsx";
import { Icon } from "../../components/icons.tsx";
import { Card } from "../../components/kit/Card.tsx";
import { EmptyState } from "../../components/kit/EmptyState.tsx";
import { IconButton } from "../../components/kit/IconButton.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Skeleton } from "../../components/kit/Skeleton.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { Button, Failed } from "../../components/ui.tsx";
import { decideQuietly, deciding, isWaiting } from "../../lib/approvals.ts";
import { ago } from "../../lib/format.ts";
import {
  type ApproveAllResult,
  type ApprovedItem,
  approvalCard,
  approveAllResult,
  coverable,
  groupApprovals,
  type Reach,
  sendDraftId,
  sendReach,
  sendRecipients,
} from "../../lib/needsYou.ts";
import { useActions } from "../../lib/query.ts";
import { createSettled, noneNew, sameIds } from "../../lib/settled.ts";
import { toolDoing } from "../../lib/toolNames.ts";
import type {
  Approval,
  InboxRow,
  MailAddress,
  MailDraft,
  MailThreadView,
} from "../../lib/types.ts";
import { type Mark, RecipientList } from "./Recipients.tsx";

/** "Approve all", kept by Today so what it says outlives the cards it covered. */
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
}) {
  // The approvals on screen a moment, wherever they are in the list: what Approve all may cover.
  // One that just came (below the fold, say) waits for a look; one that only moved into a group,
  // once its recipients were checked, was on screen already.
  const onScreen = createSettled(() => props.approvals.map((a) => a.id), {
    same: sameIds,
    safe: noneNew,
    ...(untrack(props.opening) ? {} : { initial: [] as string[] }),
  });
  const draftOf = (a: Approval) => props.drafts?.find((d) => d.id === sendDraftId(a));
  // The conversations the sends answer, read as a draft's card reads them (the same cache).
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
      >
        <Show when={reach(a)}>
          {(r) => <SendsTo approval={a} reach={r()} checking={!!draftOf(a) || !props.drafts} />}
        </Show>
      </ApprovalCard>
    );
  };

  return (
    <section aria-labelledby="today-needs" data-jump="today-needs" class="scroll-mt-4 space-y-3">
      <SectionHeader id="today-needs" title="Needs you" count={props.approvals.length} />
      <For each={keys()}>
        {(key) => (
          <Group
            group={key}
            action={itemsOf(key)[0]?.action ?? key}
            items={itemsOf(key)}
            card={card}
            approving={props.approving}
            seen={onScreen.armed()}
          />
        )}
      </For>
    </section>
  );
}

/** Approvals of one kind: each alone, or under one "Approve all" when there are several. */
function Group(props: {
  group: string;
  action: string;
  items: readonly Approval[];
  card: (a: Approval, open: boolean) => JSX.Element;
  approving: ApproveAll;
  /** The approvals on screen a moment. */
  seen: readonly string[];
}) {
  const live = () =>
    props.items.filter((a) => isWaiting(a.id, a.status) && !deciding(a.id)).map((a) => a.id);
  // What a tap covers: the cards on screen a moment. One that just arrived waits for a look.
  const arrived = () => live().filter((id) => !props.seen.includes(id)).length;
  const running = () => props.approving.running() === props.group;
  const approveAll = () => {
    if (arrived() > 0) return;
    const covered = live().filter((id) => props.seen.includes(id));
    void props.approving.run(
      props.group,
      props.items.filter((a) => covered.includes(a.id)),
    );
  };
  return (
    <Show
      when={props.items.length > 1}
      fallback={<For each={props.items}>{(a) => props.card(a, false)}</For>}
    >
      <div class="space-y-2 rounded-xl bg-sunk p-2 ring-1 ring-line ring-inset">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 pr-1 pl-2">
          {/* Never squeezed: narrow, the button goes under it, and the note under both. */}
          <p class="min-w-40 flex-1 text-sm">
            <span class="font-medium">{toolDoing(props.action)}</span>
            <span class="text-muted"> · {props.items.length} waiting</span>
          </p>
          <Show when={arrived() > 0}>
            <p
              role="status"
              class="order-last flex basis-full items-center gap-1 pb-1 text-meta font-medium text-warn"
            >
              <Icon name="warn" size={14} />
              {`${arrived()} new — look again`}
            </p>
          </Show>
          <Show when={live().length > 1 || running()}>
            <Button
              kind="primary"
              small
              icon="check"
              disabled={props.approving.running() !== null || arrived() > 0}
              onClick={approveAll}
            >
              {running() ? "Approving…" : `Approve all ${live().length}`}
            </Button>
          </Show>
        </div>
        <For each={props.items}>{(a) => props.card(a, true)}</For>
      </div>
    </Show>
  );
}

/** Who a send reaches, when someone on it is new: in red, as Ready to send marks it. */
function SendsTo(props: { approval: Approval; reach: Reach; checking: boolean }) {
  const list = () => sendRecipients(props.approval);
  const outside = () => {
    const r = props.reach;
    return r.kind === "new" || (r.kind === "reply" && r.strangers.size > 0);
  };
  const mark = (a: MailAddress): Mark => {
    const r = props.reach;
    if (r.kind === "new") return "new";
    return r.kind === "reply" && r.strangers.has(a.address.trim().toLowerCase())
      ? "stranger"
      : null;
  };
  return (
    <Show
      when={outside() && list()}
      fallback={
        <Show when={props.reach.kind === "unknown" && props.checking}>
          <p class="mt-2 text-meta text-muted">Checking who it goes to…</p>
        </Show>
      }
    >
      {(l) => (
        <RecipientList
          class="mt-3 rounded-md border border-line p-3"
          to={l().to}
          cc={l().cc}
          bcc={l().bcc}
          mark={mark}
        />
      )}
    </Show>
  );
}

/** What "Approve all" did, over Needs you: kept until you close it, even once the cards are gone. */
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
      <EmptyState icon="ok" title="You're clear" class="py-8">
        Nothing needs your yes right now. When Jarvis needs one, it'll be here, with what it would
        do in full.
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
