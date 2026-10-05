// Today's "Replies you owe": up to five conversations waiting on your answer, longest-waiting first
// as Mail's To reply lists them, each opening its conversation; "All" opens Mail's To reply.

import { For, Show } from "solid-js";
import { Avatar } from "../../components/kit/Avatar.tsx";
import { Pill } from "../../components/kit/Pill.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { ago } from "../../lib/format.ts";
import { layout } from "../../lib/panes.ts";
import { act } from "../../lib/query.ts";
import type { MailThread } from "../../lib/types.ts";
import { named, openToReply } from "../Mail.tsx";
import { CardEmpty, CardWaiting, TodayCard, TodayRow } from "./parts.tsx";

export function Replies(props: {
  query: QueryRead<unknown>;
  threads: readonly MailThread[];
  /** How many conversations wait on you in all. */
  total: number;
  /** Conversations with a reply Jarvis drafted. */
  drafted: ReadonlySet<string>;
}) {
  const open = (t: MailThread, beside: boolean) => {
    if (t.unread) void act("mail.mark_read", { ids: [t.id] });
    layout.open({ view: "thread", id: t.id }, { beside });
  };
  return (
    <TodayCard
      product="mail"
      icon="mail"
      title="Replies you owe"
      count={props.total}
      more={{ run: openToReply }}
    >
      <Show
        when={props.query.data !== undefined}
        fallback={<CardWaiting query={props.query} what="your mail" />}
      >
        <Show
          when={props.threads.length > 0}
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
                      <span class="flex flex-col items-end gap-1">
                        <span class="text-meta text-muted tabular-nums">
                          {ago(t.waitingSince ?? t.lastMessageAt)}
                        </span>
                        <Show when={props.drafted.has(t.id)}>
                          <Pill tone="jarvis" icon="reply">
                            Drafted
                          </Pill>
                        </Show>
                      </span>
                    }
                    onOpen={(beside) => open(t, beside)}
                  />
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </TodayCard>
  );
}
