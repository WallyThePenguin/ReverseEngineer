// Today's "Replies you owe": up to five conversations waiting on your answer that nobody has
// drafted a reply to yet, longest-waiting first as Mail's To reply lists them, each opening its
// conversation. The ones Jarvis drafted a reply to are on Today already (ready to send, or asking
// for your yes), so they're one line here, which takes you to them. "All" opens Mail's To reply.

import { For, Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { Avatar } from "../../components/kit/Avatar.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { ago } from "../../lib/format.ts";
import { act } from "../../lib/query.ts";
import type { MailThread } from "../../lib/types.ts";
import { named } from "../Mail.tsx";
import { CardEmpty, CardWaiting, type Go, TodayCard, TodayRow } from "./parts.tsx";

export function Replies(props: {
  query: QueryRead<unknown>;
  /** The ones still to write, up to five. */
  threads: readonly MailThread[];
  /** How many conversations wait on you in all, drafted or not. */
  total: number;
  /** How many of them have a reply Jarvis drafted, shown on Today already. */
  drafted: number;
  go: Go;
  /** Opens Mail's To reply. */
  all: () => void;
  /** Takes you to the drafted replies on Today. */
  toDrafts: () => void;
}) {
  // "3 more have a reply Jarvis drafted", or without "more" when they're all there is.
  const draftedLine = () =>
    `${props.drafted} ${props.threads.length ? "more " : ""}${props.drafted === 1 ? "has" : "have"} a reply Pip drafted`;
  const open = (t: MailThread, beside: boolean) => {
    if (t.unread) void act("mail.mark_read", { ids: [t.id] });
    props.go({ view: "thread", id: t.id }, beside);
  };
  return (
    <TodayCard
      product="mail"
      icon="mail"
      title="Replies you owe"
      count={props.total}
      more={{ run: props.all }}
    >
      <Show
        when={props.query.data !== undefined}
        fallback={<CardWaiting query={props.query} what="your mail" />}
      >
        <Show
          when={props.threads.length > 0 || props.drafted > 0}
          fallback={<CardEmpty>Nobody is waiting on a reply from you.</CardEmpty>}
        >
          <ul>
            <For each={props.threads}>
              {(t) => {
                // Everyone in it but you, as Mail's list names them.
                const them = () => t.participants.filter((p) => p.address !== t.account);
                return (
                  <TodayRow
                    lead={<Avatar name={them()[0]?.name} email={them()[0]?.address} size={24} />}
                    title={
                      <span class={`block truncate ${t.unread ? "font-semibold" : ""}`}>
                        {them().map(named).join(", ") || "me"}
                      </span>
                    }
                    meta={t.subject}
                    end={
                      <span class="text-meta text-muted tabular-nums">
                        {ago(t.waitingSince ?? t.lastMessageAt)}
                      </span>
                    }
                    onOpen={(beside) => open(t, beside)}
                  />
                );
              }}
            </For>
            <Show when={props.drafted > 0}>
              <TodayRow
                lead={<Icon name="reply" class="mx-1 text-jarvis" />}
                title={<span class="text-muted">{draftedLine()}</span>}
                end={<Icon name="chevron-right" size={14} class="text-muted" />}
                onOpen={props.toDrafts}
              />
            </Show>
          </ul>
        </Show>
      </Show>
    </TodayCard>
  );
}
