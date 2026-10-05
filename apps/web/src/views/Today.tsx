// Today: your morning on one screen. What needs your yes, the brief, the drafts Jarvis has ready to
// send, your day, what's due, who's waiting on a reply and what Jarvis did since yesterday, each
// thing that needs you one tap away. It's made only of reads the other screens make already, so
// it refreshes with them. On a wide pane what needs you runs down the left, the day down the right;
// on a phone, one after the other.

import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Button, PaneHeader } from "../components/ui.tsx";
import { usePush } from "../lib/push.ts";
import { inboxInput, useAction, usePendingApprovals } from "../lib/query.ts";
import {
  askedToSend,
  dayPlan,
  greeting,
  jarvisDrafts,
  sinceYesterday,
  splitDue,
  summary,
} from "../lib/today.ts";
import type { CalEvent, InboxRow, MailDraft, MailThread, Task, Turn } from "../lib/types.ts";
import { Brief } from "./today/Brief.tsx";
import { Due } from "./today/Due.tsx";
import { JarvisDid } from "./today/JarvisDid.tsx";
import { Clear, NeedsYou, NeedsYouWaiting } from "./today/NeedsYou.tsx";
import { ReadyToSend } from "./today/ReadyToSend.tsx";
import { Replies } from "./today/Replies.tsx";
import { YourDay } from "./today/YourDay.tsx";

const DAY = 86_400_000;

export function Today(_props: { pane: number }) {
  // The clock moves the meetings on, and a new day brings a new day's reads.
  const [now, setNow] = createSignal(new Date());
  const timer = window.setInterval(() => setNow(new Date()), 60_000);
  onCleanup(() => window.clearInterval(timer));
  const dayStart = createMemo(() => {
    const n = now();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  });

  const approvals = usePendingApprovals();
  const inbox = useAction<InboxRow[]>("inbox.list", () => inboxInput("live", "signal"));
  const drafts = useAction<MailDraft[]>("mail.drafts");
  // Today, and the two weeks after it for invitations still to answer.
  const events = useAction<CalEvent[]>("calendar.events", () => ({
    from: new Date(dayStart()).toISOString(),
    to: new Date(dayStart() + 15 * DAY).toISOString(),
  }));
  const tasks = useAction<Task[]>("task.list", () => ({
    dueBefore: new Date(dayStart() + DAY - 1).toISOString(),
    limit: 100,
  }));
  const replies = useAction<MailThread[]>("mail.threads", () => ({
    view: "inbox",
    waiting: "you",
    limit: 5,
  }));
  const counts = useAction<{ unread: number; toReply: number }>("mail.counts");
  const turns = useAction<Turn[]>("jarvis.activity", () => ({ limit: 100 }));
  const push = usePush();

  // Send sends what's shown, so the drafts are read again on arrival, and Send waits for that.
  const opened = Date.now();
  onMount(() => void drafts.refetch());
  const fresh = () => !drafts.isFetching && drafts.dataUpdatedAt >= opened;

  const pending = () => approvals.data ?? [];
  const mine = createMemo(() => jarvisDrafts(drafts.data));
  // A draft Jarvis already asked to send waits in Needs you, so it isn't offered here as well.
  const ready = createMemo(() => {
    const asked = askedToSend(approvals.data);
    return mine().filter((d) => !asked.has(d.id));
  });
  const plan = createMemo(() => dayPlan(events.data, now()));
  const due = createMemo(() => splitDue(tasks.data, now()));
  const did = createMemo(() => sinceYesterday(turns.data, now()));
  const brief = () => inbox.data?.find((r) => r.notification.kind === "brief");
  const drafted = createMemo(
    () => new Set(mine().flatMap((d) => (d.threadId ? [d.threadId] : []))),
  );
  const line = () =>
    summary({
      needs: pending().length + ready().length,
      meetings: plan().today.filter((e) => !e.allDay).length,
      due: due().overdue.length + due().today.length,
    });

  return (
    <div class="flex h-full flex-col" data-product="today">
      <PaneHeader
        title="Today"
        sub={now().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
      />
      <div class="@container flex-1 overflow-auto bg-bg">
        <div class="mx-auto max-w-6xl px-4 pt-6 pb-12 md:px-8 md:pt-8">
          <header class="flex flex-wrap items-end gap-x-6 gap-y-3">
            {/* On a phone the button goes under the line, rather than squeezing it. */}
            <div class="min-w-0 flex-1 basis-72">
              <p class="text-display">{greeting(now())}</p>
              <p class="mt-1 text-sm text-muted">{line()}</p>
            </div>
            <Show when={push.canTurnOn()}>
              <Button icon="bell" disabled={push.busy()} onClick={() => void push.turnOn()}>
                Turn on notifications
              </Button>
            </Show>
          </header>
          <div class="mt-6 grid gap-x-6 gap-y-8 @4xl:grid-cols-[minmax(0,1fr)_minmax(19rem,22rem)] @4xl:items-start">
            <div class="min-w-0 space-y-8">
              <Show when={approvals.data !== undefined} fallback={<NeedsYouWaiting />}>
                <Show
                  when={pending().length > 0}
                  fallback={
                    <Show when={drafts.data !== undefined && ready().length === 0}>
                      <Clear />
                    </Show>
                  }
                >
                  <NeedsYou approvals={pending()} inbox={inbox.data} />
                </Show>
              </Show>
              <Show when={brief()}>{(row) => <Brief row={row()} />}</Show>
              <Show when={ready().length > 0}>
                <ReadyToSend drafts={ready()} fresh={fresh()} />
              </Show>
            </div>
            <div class="min-w-0 space-y-4">
              <YourDay query={events} today={plan().today} invites={plan().invites} now={now()} />
              <Due query={tasks} overdue={due().overdue} today={due().today} now={now()} />
              <Replies
                query={replies}
                threads={replies.data ?? []}
                total={counts.data?.toReply ?? replies.data?.length ?? 0}
                drafted={drafted()}
              />
              <JarvisDid query={turns} turns={did()} now={now()} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
