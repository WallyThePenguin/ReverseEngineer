// Today's "Ready to send": the replies Jarvis drafted, each whole (who it goes to, the subject and
// every word), with Send, Edit and Discard. Send sends exactly what's shown: Hearth refuses a draft
// that changed since (mail/send.ts). Anyone it would reach who isn't in the conversation yet is
// marked in red, and Send waits until the draft and its conversation have just been read.

import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { Card } from "../../components/kit/Card.tsx";
import { Pill } from "../../components/kit/Pill.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { Button } from "../../components/ui.tsx";
import { ago } from "../../lib/format.ts";
import { toast } from "../../lib/live.ts";
import { layout } from "../../lib/panes.ts";
import { act, useAction } from "../../lib/query.ts";
import { draftSnapshot, participantsOf, strangers } from "../../lib/today.ts";
import type { MailAddress, MailDraft, MailThreadView } from "../../lib/types.ts";

export function ReadyToSend(props: {
  drafts: readonly MailDraft[];
  /** The drafts were read since Today opened, and aren't being read again right now. */
  fresh: boolean;
}) {
  return (
    <section aria-labelledby="today-drafts" class="space-y-3">
      <SectionHeader
        id="today-drafts"
        title="Ready to send"
        count={props.drafts.length}
        more={{ label: "Mail", run: () => layout.open({ view: "mail" }) }}
      />
      <For each={props.drafts}>{(d) => <DraftCard draft={d} fresh={props.fresh} />}</For>
    </section>
  );
}

function DraftCard(props: { draft: MailDraft; fresh: boolean }) {
  const id = createUniqueId();
  const d = () => props.draft;
  const [busy, setBusy] = createSignal(false);
  const thread = useAction<MailThreadView>(
    "mail.thread",
    () => ({ id: d().threadId }),
    () => !!d().threadId,
  );
  // Who it would reach that isn't in its conversation; nobody, for a new message.
  const outsiders = createMemo(() =>
    thread.data ? strangers(d(), participantsOf(thread.data)) : new Set<string>(),
  );
  const stranger = (a: MailAddress) => outsiders().has(a.address.trim().toLowerCase());
  const recipients = () => d().to.length + d().cc.length + d().bcc.length;
  // Why Send can't go yet, if it can't.
  const wait = () => {
    if (!d().account) return "Pick which account it goes from first: Edit.";
    if (recipients() === 0) return "Add who it goes to first: Edit.";
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
        snapshot: draftSnapshot(d()),
      });
      if (sent)
        toast.show(
          sent.alreadySent ? "It had already gone out, so it wasn't sent again." : "Sent.",
        );
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try {
      if (await act("mail.discard", { id: d().id })) toast.show("Draft thrown away.");
    } finally {
      setBusy(false);
    }
  };
  // The draft opens where it's written: its conversation, or Mail for a new message.
  const edit = () => {
    const thread = d().threadId;
    layout.open(thread ? { view: "thread", id: thread } : { view: "mail" });
  };

  return (
    <Card labelledby={id}>
      <div class="flex items-start gap-2.5">
        <JarvisMark size={18} class="mt-0.5" />
        <div class="min-w-0 flex-1">
          <h3 id={id} class="text-heading break-words">
            {d().subject || "(no subject)"}
          </h3>
          <p class="text-meta text-muted">
            {d().threadId ? "A reply" : "A new email"} Jarvis drafted {ago(d().updatedAt)}
          </p>
        </div>
      </div>
      <dl class="mt-3 space-y-1.5 text-sm">
        <Recipients label="To" list={d().to} stranger={stranger} />
        <Show when={d().cc.length > 0}>
          <Recipients label="Cc" list={d().cc} stranger={stranger} />
        </Show>
        <Show when={d().bcc.length > 0}>
          <Recipients label="Bcc" list={d().bcc} stranger={stranger} />
        </Show>
      </dl>
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
    </Card>
  );
}

/** Who it goes to; anyone not already in the conversation is in red, and says so. */
function Recipients(props: {
  label: string;
  list: readonly MailAddress[];
  stranger: (a: MailAddress) => boolean;
}) {
  return (
    <div class="flex gap-3">
      <dt class="w-8 shrink-0 text-muted">{props.label}</dt>
      <dd class="flex min-w-0 flex-1 flex-col gap-1">
        <Show when={props.list.length > 0} fallback={<span class="text-muted">Nobody yet</span>}>
          <For each={props.list}>
            {(a) => (
              <span
                class={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 ${props.stranger(a) ? "text-bad" : ""}`}
              >
                <span class="font-medium">{a.name || a.address}</span>
                <Show when={a.name}>
                  <span class={`break-all ${props.stranger(a) ? "" : "text-muted"}`}>
                    {a.address}
                  </span>
                </Show>
                <Show when={props.stranger(a)}>
                  <Pill tone="bad">not in this conversation</Pill>
                </Show>
              </span>
            )}
          </For>
        </Show>
      </dd>
    </div>
  );
}
