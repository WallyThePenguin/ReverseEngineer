// Today: your morning on one screen. A greeting with a box to ask Jarvis or add a task, the brief
// (one line once you've read it), what needs your yes, the drafts Jarvis has ready to send, your
// day, what's due, who's waiting on a reply and what Jarvis did since yesterday, each thing that
// needs you one tap away. It's made only of reads the other screens make already, so it refreshes
// with them. On a wide pane what needs you runs down the left, the day down the right; on a phone,
// one after the other, with the meeting on now or next under the greeting. What a row opens goes
// beside Today, as from any list, so Today stays where it was.

import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { HomeScreenSteps } from "../components/HomeScreenSteps.tsx";
import { Card } from "../components/kit/Card.tsx";
import { SectionHeader } from "../components/kit/SectionHeader.tsx";
import { SetupChecklist } from "../components/SetupChecklist.tsx";
import { Button, Failed, PaneHeader } from "../components/ui.tsx";
import { createToday, timeNow } from "../lib/clock.ts";
import { askedToSend } from "../lib/needsYou.ts";
import { layout, type PaneRoute, routeFor } from "../lib/panes.ts";
import { usePush } from "../lib/push.ts";
import { inboxInput, useAction, usePendingApprovals } from "../lib/query.ts";
import {
  dayPlan,
  greeting,
  jarvisDrafts,
  owed,
  sinceYesterday,
  splitDue,
  startOfYesterday,
  summary,
} from "../lib/today.ts";
import type { CalEvent, Did, InboxRow, MailDraft, MailThread, Task, Turn } from "../lib/types.ts";
import { openToReply } from "./Mail.tsx";
import { AskBar } from "./today/AskBar.tsx";
import { Brief } from "./today/Brief.tsx";
import { Due } from "./today/Due.tsx";
import { JarvisDid } from "./today/JarvisDid.tsx";
import {
  ApproveAllSaid,
  Clear,
  NeedsYou,
  NeedsYouWaiting,
  useApproveAll,
} from "./today/NeedsYou.tsx";
import { ReadyToSend } from "./today/ReadyToSend.tsx";
import { Replies } from "./today/Replies.tsx";
import { UpNext, YourDay } from "./today/YourDay.tsx";

const DAY = 86_400_000;

export function Today(props: { pane: number }) {
  // The clock moves the meetings on with every other row (lib/clock.ts), and a new day brings a
  // new day's reads.
  const now = createMemo(() => timeNow());
  const dayStart = createToday();

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
  // Enough of them to leave out the ones with a reply drafted and still have five.
  const replies = useAction<MailThread[]>("mail.threads", () => ({
    view: "inbox",
    waiting: "you",
    limit: 50,
  }));
  const counts = useAction<{ unread: number; toReply: number }>("mail.counts");
  // What Jarvis made since yesterday, and its runs, for the ones that didn't finish.
  const since = createMemo(() => startOfYesterday(new Date(dayStart())).toISOString());
  const made = useAction<Did[]>("jarvis.did", () => ({ since: since(), limit: 50 }));
  const turns = useAction<Turn[]>("jarvis.activity", () => ({ limit: 100 }));
  const push = usePush();
  // On an iPhone in Safari, Turn on notifications shows the step that makes them possible.
  const [homeScreenSteps, showHomeScreenSteps] = createSignal(false);
  const approving = useApproveAll();
  // What was waiting when Today first heard: Needs you's first showing is what Today opened on
  // only if it's those. If Today opened with nothing waiting, what shows later has only just come,
  // and Approve all waits a moment before covering it. Asking counts as showing it.
  const openedOn = createMemo<ReadonlySet<string> | null>(
    (prev) => prev ?? (approvals.data ? new Set(approvals.data.map((a) => a.id)) : null),
    null,
  );
  let shownOnce = false;
  const opening = () => {
    const on = openedOn();
    const first = !shownOnce && on !== null && pending().every((a) => on.has(a.id));
    shownOnce = true;
    return first;
  };

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
  const readyIds = createMemo(() => new Set(ready().map((d) => d.id)));
  const plan = createMemo(() => dayPlan(events.data, now()));
  const due = createMemo(() => splitDue(tasks.data, now()));
  const failed = createMemo(
    () => sinceYesterday(turns.data, now()).filter((t) => t.status === "failed").length,
  );
  // A drafted reply opens in its conversation, where it's written; anything else as itself.
  const routeOf = (d: Did): PaneRoute => {
    const thread = drafts.data?.find((x) => x.id === d.entityId)?.threadId;
    return thread ? { view: "thread", id: thread } : routeFor(d.entityType, d.entityId);
  };
  const brief = () => inbox.data?.find((r) => r.notification.kind === "brief");
  // Conversations with a reply Jarvis drafted: it's on Today already, ready or asking.
  const owing = createMemo(() =>
    owed(replies.data, new Set(mine().flatMap((d) => (d.threadId ? [d.threadId] : [])))),
  );
  const line = () =>
    summary({
      approvals: approvals.data ? pending().length : null,
      ready: drafts.data ? ready().length : null,
      meetings: plan().today.filter((e) => !e.allDay).length,
      due: due().overdue.length + due().today.length,
    });
  const clear = () =>
    approvals.data !== undefined &&
    pending().length === 0 &&
    drafts.data !== undefined &&
    ready().length === 0 &&
    !approving.result();

  // Beside Today, as from any list (on a phone, over it, and closing goes back); shift for a new pane.
  const go = (route: PaneRoute, beside = false) => {
    if (beside) layout.open(route, { beside: true });
    else layout.show(route, props.pane);
  };
  let root: HTMLDivElement | undefined;
  const jump = (to: string) =>
    root
      ?.querySelector(`[data-jump="${to}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div class="flex h-full flex-col" data-product="today">
      <PaneHeader title="Today" />
      <div ref={root} class="@container flex-1 overflow-auto bg-bg">
        <div class="mx-auto max-w-6xl px-4 pt-6 pb-12 md:px-8 md:pt-8">
          <header class="flex flex-wrap items-end gap-x-6 gap-y-3">
            {/* On a phone the button goes under the line, rather than squeezing it. */}
            <div class="min-w-0 flex-1 basis-72">
              <p class="text-meta font-medium tracking-wide text-muted uppercase">
                {now().toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </p>
              <h2 class="mt-1 text-hero">{greeting(now())}</h2>
              {/* Each part counts what its section shows, and takes you to it. Kept by its words:
                  the minute moving on doesn't draw it again, and the focus stays on it. */}
              <p class="mt-1 flex flex-wrap gap-x-1.5 text-sm text-muted">
                <For each={line().map((part) => part.text)}>
                  {(text, i) => (
                    <>
                      <Show when={i() > 0}>
                        <span aria-hidden="true">·</span>
                      </Show>
                      <button
                        type="button"
                        class="rounded-sm underline-offset-2 hover:text-ink hover:underline"
                        onClick={() => {
                          const to = line().find((part) => part.text === text)?.to;
                          if (to) jump(to);
                        }}
                      >
                        {text}
                      </button>
                    </>
                  )}
                </For>
              </p>
            </div>
            <Show when={push.canTurnOn() || (push.needsHomeScreen && !homeScreenSteps())}>
              <Button
                icon="bell"
                disabled={push.busy()}
                onClick={() =>
                  push.needsHomeScreen ? showHomeScreenSteps(true) : void push.turnOn()
                }
              >
                Turn on notifications
              </Button>
            </Show>
          </header>
          <Show when={homeScreenSteps()}>
            <HomeScreenSteps class="mt-4 max-w-xl" />
          </Show>
          <AskBar go={go} now={now()} class="mt-5 max-w-2xl" />
          {/* Hearth opens here, so what's still to connect shows here first. */}
          <SetupChecklist pane={props.pane} class="mt-6" />
          <UpNext today={plan().today} now={now()} go={go} class="mt-4 @4xl:hidden" />
          <div class="mt-6 grid gap-x-6 gap-y-8 @4xl:grid-cols-[minmax(0,1fr)_minmax(19rem,22rem)] @4xl:items-start">
            <div class="flex min-w-0 flex-col gap-8">
              {/* What Approve all said stays over Needs you, even once its cards have gone. */}
              <Show
                when={
                  approving.result() || approvals.data === undefined || pending().length || clear()
                }
              >
                <div class="space-y-3">
                  <ApproveAllSaid approving={approving} ready={readyIds()} />
                  <Show
                    when={approvals.data !== undefined}
                    fallback={<NeedsYouWaiting query={approvals} />}
                  >
                    <Show
                      when={pending().length > 0}
                      fallback={
                        <Show when={clear()}>
                          <Clear />
                        </Show>
                      }
                    >
                      <NeedsYou
                        approvals={pending()}
                        inbox={inbox.data}
                        drafts={drafts.data}
                        approving={approving}
                        opening={opening}
                        go={go}
                      />
                    </Show>
                  </Show>
                </div>
              </Show>
              {/* On a phone the brief's one line comes after what needs you, so that stays on the
                  first screen; when it's wide, the brief heads the column. Each new brief is drawn
                  afresh (keyed), so yesterday's being read doesn't make today's read. */}
              <Show when={brief()?.notification.id} keyed>
                {(_id) => <Brief row={brief()!} go={go} class="@4xl:order-first" />}
              </Show>
              <Show when={drafts.data === undefined && drafts.isError}>
                <section aria-labelledby="today-drafts" class="space-y-3">
                  <SectionHeader id="today-drafts" title="Ready to send" />
                  <Card flush>
                    <Failed error={drafts.error} retry={drafts.refetch} what="Jarvis's drafts" />
                  </Card>
                </section>
              </Show>
              <Show when={ready().length > 0}>
                <ReadyToSend drafts={ready()} fresh={fresh()} go={go} />
              </Show>
            </div>
            <div class="min-w-0 space-y-4">
              <YourDay
                query={events}
                today={plan().today}
                invites={plan().invites}
                now={now()}
                go={go}
              />
              <Due query={tasks} overdue={due().overdue} today={due().today} now={now()} go={go} />
              <Replies
                query={replies}
                threads={owing().rows}
                total={counts.data?.toReply ?? replies.data?.length ?? 0}
                drafted={owing().drafted}
                go={go}
                all={() => openToReply(props.pane)}
                toDrafts={() => jump(ready().length ? "today-drafts" : "today-needs")}
              />
              <JarvisDid
                query={made}
                items={made.data ?? []}
                failed={failed()}
                now={now()}
                go={go}
                routeOf={routeOf}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
