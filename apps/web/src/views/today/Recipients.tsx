// Who a draft or a send goes to, on Today, and its subject in full: the address first and in full,
// the name after it and quieter, so a name can't pass for another recipient (mail/drafts.ts).
// Anyone who isn't already in the conversation is in red and says so; on a new email everyone is
// new, so each says that. With the text under it, that's all of what a yes sends (D33).

import { For, Show } from "solid-js";
import { Pill } from "../../components/kit/Pill.tsx";
import type { MailAddress } from "../../lib/types.ts";

/** How a recipient is marked: not in the conversation, on a new email, or neither. */
export type Mark = "stranger" | "new" | null;

export function RecipientList(props: {
  to: readonly MailAddress[];
  cc: readonly MailAddress[];
  bcc: readonly MailAddress[];
  mark: (a: MailAddress) => Mark;
  /** The subject, "" for none. */
  subject: string;
  class?: string;
}) {
  // The labels are one column as wide as the widest, each row's contents beside its label.
  return (
    <dl
      class={`grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm ${props.class ?? ""}`}
    >
      <Row label="To" list={props.to} mark={props.mark} />
      <Show when={props.cc.length > 0}>
        <Row label="Cc" list={props.cc} mark={props.mark} />
      </Show>
      <Show when={props.bcc.length > 0}>
        <Row label="Bcc" list={props.bcc} mark={props.mark} />
      </Show>
      <div class="contents">
        <dt class="text-muted">Subject</dt>
        <dd class={`min-w-0 break-words ${props.subject ? "font-medium" : "text-muted"}`}>
          {props.subject || "(no subject)"}
        </dd>
      </div>
    </dl>
  );
}

function Row(props: {
  label: string;
  list: readonly MailAddress[];
  mark: (a: MailAddress) => Mark;
}) {
  return (
    <div class="contents">
      <dt class="text-muted">{props.label}</dt>
      <dd class="flex min-w-0 flex-col gap-1">
        <Show when={props.list.length > 0} fallback={<span class="text-muted">Nobody yet</span>}>
          <For each={props.list}>
            {(a) => {
              const mark = () => props.mark(a);
              return (
                <span
                  class={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 ${mark() === "stranger" ? "text-bad" : ""}`}
                >
                  <span class="font-medium break-all">{a.address}</span>
                  <Show when={a.name}>
                    <span class={mark() === "stranger" ? "" : "text-muted"}>{a.name}</span>
                  </Show>
                  <Show when={mark() === "stranger"}>
                    <Pill tone="bad">not in this conversation</Pill>
                  </Show>
                  <Show when={mark() === "new"}>
                    <Pill tone="warn">new email — check who it goes to</Pill>
                  </Show>
                </span>
              );
            }}
          </For>
        </Show>
      </dd>
    </div>
  );
}
