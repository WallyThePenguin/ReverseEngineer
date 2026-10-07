// One approval on Today's "Needs you", as a line. A send says who it goes to by name and its
// subject, and opens in place to exactly what a yes would send: who it reaches, addresses first
// and in full so a name can't pass for another, anyone new in red, the whole subject and every
// word, with Deny and Approve under it (D33, D58). Anything else says what it would do; when that
// line is all there is to it (an invitation, say), its yes sits on the line, and otherwise it opens
// like a send. A reason other than Hearth's usual one, which Today says once over the list, stays
// on the row.

import { type JSX, Show } from "solid-js";
import { Decide, ExactText } from "../../components/ApprovalCard.tsx";
import type { IconName } from "../../components/icons.tsx";
import { Avatar } from "../../components/kit/Avatar.tsx";
import {
  alwaysAllowWords,
  approvalStateText,
  decidedAs,
  isWaiting,
  type Said,
} from "../../lib/approvals.ts";
import { ago, humanTimes } from "../../lib/format.ts";
import {
  approvalCard,
  askRow,
  namesOf,
  ownWhy,
  type Reach,
  sendFrom,
  sendRecipients,
  sendSubject,
} from "../../lib/needsYou.ts";
import type { Approval, InboxRow, MailAddress, MailDraft } from "../../lib/types.ts";
import { FoldRow, KindMark } from "./FoldRow.tsx";
import type { Go } from "./parts.tsx";
import { type Mark, RecipientList } from "./Recipients.tsx";

/** What a row that isn't a send leads with: the kind of thing it would change. */
const KIND: Record<string, IconName> = {
  calendar: "calendar",
  mail: "mail",
  task: "tasks",
  note: "docs",
  browser: "browser",
};
const kindOf = (action: string): IconName => KIND[action.split(".")[0] ?? ""] ?? "info";

export function AskRow(props: {
  approval: Approval;
  /** Its inbox row, whose card names records by their titles. */
  inbox: InboxRow | undefined;
  /** The draft a send would send, once the drafts are in. */
  draft: MailDraft | undefined;
  /** Who a send would reach; null for anything else. */
  reach: Reach | null;
  /** Who it reaches is still being checked. */
  checking: boolean;
  open: boolean;
  onToggle: () => void;
  go: Go;
}) {
  const a = () => props.approval;
  const parts = () => approvalCard(a(), props.inbox);
  // A reply or a new email, once its draft is known.
  const line = () => askRow(a(), parts(), props.draft ? props.draft.threadId !== null : null);
  const to = () => sendRecipients(a())?.to ?? [];
  const why = () => ownWhy(parts().why);
  const waiting = () => isWaiting(a().id, a().status);
  const asked = () => `Asked ${ago(a().createdAt)}`;
  // Where Jarvis asked in a conversation you started, as the Approvals view offers it (D70).
  const always = () => alwaysAllowWords(a());
  // A send says who it reached, and View opens its conversation.
  const said = (): Said | undefined => {
    if (a().action !== "mail.send") return undefined;
    const t = props.draft?.threadId;
    return {
      text: `Sent to ${namesOf(to())}`,
      ...(t ? { action: { label: "View", run: () => props.go({ view: "thread", id: t }) } } : {}),
    };
  };
  const end = (): JSX.Element => {
    if (!waiting())
      return (
        <span class="text-meta text-muted">
          {approvalStateText(decidedAs(a().id) ?? a().status ?? "gone")}
        </span>
      );
    return line().whole ? (
      <Decide approvalId={a().id} said={said()} always={always()} draft={props.draft} />
    ) : undefined;
  };
  return (
    <FoldRow
      lead={
        <Show when={to()[0]} fallback={<KindMark icon={kindOf(a().action)} />}>
          {(first) => <Avatar size={32} name={first().name} email={first().address} />}
        </Show>
      }
      title={humanTimes(line().title)}
      sub={[line().sub, line().whole ? why() : null, asked()].filter(Boolean).join(" · ")}
      end={end()}
      open={props.open && !line().whole}
      onToggle={line().whole ? undefined : props.onToggle}
    >
      <Show when={why()}>{(w) => <p class="mb-2 text-meta text-muted">{w()}</p>}</Show>
      <Show
        when={props.reach}
        fallback={<p class="text-sm break-words text-muted">{humanTimes(parts().what)}</p>}
      >
        {(r) => <SendsTo approval={a()} reach={r()} checking={props.checking} />}
      </Show>
      <Show when={parts().text}>{(text) => <ExactText text={text()} open />}</Show>
      <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-muted">
        <span class="min-w-0 flex-1 break-words">
          {[sendFrom(a()) && `From ${sendFrom(a())}`, asked()].filter(Boolean).join(" · ")}
        </span>
        <Show when={waiting()}>
          <Decide approvalId={a().id} said={said()} always={always()} draft={props.draft} />
        </Show>
      </div>
    </FoldRow>
  );
}

/** Who a send reaches, addresses first and in full, anyone new in red as Ready to send marks them. */
function SendsTo(props: { approval: Approval; reach: Reach; checking: boolean }) {
  const list = () => sendRecipients(props.approval);
  const mark = (a: MailAddress): Mark => {
    const r = props.reach;
    if (r.kind === "new") return "new";
    return r.kind === "reply" && r.strangers.has(a.address.trim().toLowerCase())
      ? "stranger"
      : null;
  };
  return (
    <>
      <Show when={list()}>
        {(l) => (
          <RecipientList
            class="mb-3"
            to={l().to}
            cc={l().cc}
            bcc={l().bcc}
            subject={sendSubject(props.approval) ?? ""}
            mark={mark}
          />
        )}
      </Show>
      <Show when={props.reach.kind === "unknown" && props.checking}>
        <p class="mb-2 text-meta text-muted">Checking who it goes to…</p>
      </Show>
    </>
  );
}
