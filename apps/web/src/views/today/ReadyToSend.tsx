// Today's "Ready to send": the replies Jarvis drafted, one line each (who it goes to and the
// subject), opening in place to the whole draft (who it goes to, the whole subject, every word)
// with Send, Edit and Discard. Send is only there once it's open, and sends exactly what's shown:
// Hearth refuses a draft that changed since (mail/send.ts), and one that changes while it's shown
// here says so and keeps Send off a moment, so what goes is what you read. Anyone it would reach
// who isn't in the conversation yet is marked in red (on a new email, everyone), on its line as
// well, and Send waits until the draft and its conversation have just been read.

import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { Avatar } from "../../components/kit/Avatar.tsx";
import { Card } from "../../components/kit/Card.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Button } from "../../components/ui.tsx";
import { ago } from "../../lib/format.ts";
import { toast } from "../../lib/live.ts";
import { mailTitle, namesOf, participantsOf, strangers } from "../../lib/needsYou.ts";
import { act, useAction } from "../../lib/query.ts";
import { createSettled } from "../../lib/settled.ts";
import { draftSnapshot } from "../../lib/today.ts";
import type { MailAddress, MailDraft, MailThreadView } from "../../lib/types.ts";
import { FoldRow, KindMark } from "./FoldRow.tsx";
import type { Go } from "./parts.tsx";
import { type Mark, RecipientList } from "./Recipients.tsx";

export function ReadyToSend(props: {
  drafts: readonly MailDraft[];
  /** The drafts were read since Today opened, and aren't being read again right now. */
  fresh: boolean;
  go: Go;
  /** Placement only. */
  class?: string;
}) {
  const ids = createMemo(() => props.drafts.map((d) => d.id), [], {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  return (
    <section
      aria-labelledby="today-drafts"
      data-jump="today-drafts"
      class={`scroll-mt-4 space-y-2 ${props.class ?? ""}`}
    >
      <SectionHeader
        id="today-drafts"
        title="Ready to send"
        count={props.drafts.length}
        more={{ label: "Mail", run: () => props.go({ view: "mail" }) }}
      />
      <Card flush>
        <ul>
          {/* By id: a draft read again with changes is the same row, which notices the change. */}
          <For each={ids()}>
            {(id) => (
              <Show when={props.drafts.find((d) => d.id === id)}>
                {(d) => <DraftRow draft={d()} fresh={props.fresh} go={props.go} />}
              </Show>
            )}
          </For>
        </ul>
      </Card>
    </section>
  );
}

function DraftRow(props: { draft: MailDraft; fresh: boolean; go: Go }) {
  const d = () => props.draft;
  const [busy, setBusy] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const thread = useAction<MailThreadView>(
    "mail.thread",
    () => ({ id: d().threadId }),
    () => !!d().threadId,
  );
  // Who it would reach that isn't in its conversation; on a new email, everyone is new.
  const outsiders = createMemo(() =>
    thread.data ? strangers(d(), participantsOf(thread.data)) : new Set<string>(),
  );
  const mark = (a: MailAddress): Mark => {
    if (!d().threadId) return "new";
    return outsiders().has(a.address.trim().toLowerCase()) ? "stranger" : null;
  };
  const recipients = () => d().to.length + d().cc.length + d().bcc.length;
  // What Send sends: the draft as it's been shown a moment. One that changes while it's open here
  // (Jarvis working on it, say) redraws, says so, and keeps Send off until it has stayed put.
  const shown = createSettled(() => JSON.stringify(draftSnapshot(d())), {
    same: (a, b) => a === b,
  });
  // Why Send can't go yet, if it can't.
  const wait = () => {
    if (!d().account) return "Pick which account it goes from first: Edit.";
    if (recipients() === 0) return "Add who it goes to first: Edit.";
    if (shown.settling()) return "It just changed: read it again before you send it.";
    if (!props.fresh || (d().threadId && !thread.data) || thread.isFetching)
      return "Checking it's the latest…";
    return null;
  };

  const send = async () => {
    setBusy(true);
    try {
      // What's shown is what's sent: Hearth refuses it if the draft changed since.
      const sent = await act<{ alreadySent?: boolean }>("mail.send", {
        id: d().id,
        snapshot: JSON.parse(shown.armed()),
      });
      if (sent?.alreadySent) toast.show("It had already gone out, so it wasn't sent again.");
      else if (sent) {
        const t = d().threadId;
        toast.show(
          `Sent to ${namesOf(d().to)}`,
          "ok",
          t ? { label: "View", run: () => props.go({ view: "thread", id: t }) } : undefined,
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try {
      const id = d().id;
      // It goes to the trash, so Undo brings it back.
      if (await act("mail.discard", { id }))
        toast.show("Draft thrown away.", "info", {
          label: "Undo",
          run: () => void act("entity.restore", { id }),
        });
    } finally {
      setBusy(false);
    }
  };
  // The draft opens where it's written: its conversation, or Mail for a new message.
  const edit = () => {
    const thread = d().threadId;
    props.go(thread ? { view: "thread", id: thread } : { view: "mail" });
  };

  // Who it reaches that's new, said on its line too, so a row you haven't opened still warns you.
  const reachesNew = () =>
    !d().threadId ? "New email" : outsiders().size ? "Adds someone new" : null;
  const first = () => d().to[0];

  return (
    <FoldRow
      lead={
        <Show when={first()} fallback={<KindMark icon="mail" />}>
          {(a) => <Avatar size={32} name={a().name} email={a().address} />}
        </Show>
      }
      title={mailTitle(d().to, d().threadId !== null)}
      sub={
        <>
          <Show when={reachesNew()}>
            {(say) => <span class="font-medium text-bad">{`${say()} · `}</span>}
          </Show>
          {`${d().subject || "(no subject)"} · drafted ${ago(d().updatedAt)}`}
        </>
      }
      open={open()}
      onToggle={() => setOpen(!open())}
    >
      <RecipientList to={d().to} cc={d().cc} bcc={d().bcc} subject={d().subject} mark={mark} />
      <Show when={shown.changed()}>
        <p role="status" class="mt-3 flex items-start gap-1.5 text-meta text-warn">
          <Icon name="warn" size={14} class="mt-px shrink-0" />
          This draft changed while it was open here. What's shown is the new version.
        </p>
      </Show>
      <p class="mt-3 rounded-md border border-line bg-sunk p-3 text-sm break-words whitespace-pre-wrap">
        {d().text}
      </p>
      {/* Narrow, the line goes over the buttons: Discard on the left, away from Send. */}
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <p class="basis-full text-meta text-muted @lg:min-w-40 @lg:flex-1 @lg:basis-auto">
          {wait() ?? (d().account ? `From ${d().account}` : "")}
        </p>
        <Button kind="danger" small icon="trash-2" disabled={busy()} onClick={() => void discard()}>
          Discard
        </Button>
        <span class="flex-1 @lg:hidden" />
        <Button small icon="pencil" onClick={edit}>
          Edit
        </Button>
        <Button
          kind="primary"
          small
          icon="send"
          disabled={busy() || wait() !== null}
          onClick={() => void send()}
        >
          Send
        </Button>
      </div>
    </FoldRow>
  );
}
