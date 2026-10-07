// Writing email: a draft saves itself as you type, and Send sends it. Drafts Jarvis wrote show up
// here too, ready to check and send. A draft is saved whole, on the version it was read as (D59,
// lib/wholeSave.ts): until Hearth has a change, a copy waits on this device, so a closed tab or a
// dropped connection loses nothing, and a change made elsewhere meanwhile (Jarvis, another screen)
// is merged in, not written over (lib/compose.ts). An address you're still typing is saved as you
// typed it; Send checks them. Send saves what's on screen and sends only that version, so nothing
// you can't see goes out. Discard puts it in the trash, with Undo.
// With more than one account, From picks which it goes from; a draft kept from an account you
// disconnected waits for you to pick one. A reply starts with the cursor in the message, and its
// Bcc and Subject (and an empty Cc) folded behind "More", unless its Bcc has anyone on it.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ApiError, action } from "../lib/api.ts";
import {
  type DraftFields,
  fieldsOf,
  foldsExtras,
  mergeDraft,
  showsCc,
  splitAddresses,
} from "../lib/compose.ts";
import { toast } from "../lib/live.ts";
import { cursorFor, cursorPlaced } from "../lib/mailActions.ts";
import { act, useAction } from "../lib/query.ts";
import type { MailAccount, MailDraft } from "../lib/types.ts";
import { createSaver } from "../lib/wholeSave.ts";

const field = "w-full rounded border border-line bg-panel px-2 py-1 text-sm";
const same = (a: DraftFields, b: DraftFields) => JSON.stringify(a) === JSON.stringify(b);

/** `conversation`: the subject of the conversation a reply is in, to tell if its Subject changed. */
export function Composer(props: { draft: MailDraft; conversation?: string; onDone?: () => void }) {
  // Read once: after this, what's typed here is the copy on screen, not the page's.
  const first = untrack(() => props.draft);
  const id = first.id;
  const start = fieldsOf(first);
  const [to, setTo] = createSignal(start.to);
  const [cc, setCc] = createSignal(start.cc);
  const [bcc, setBcc] = createSignal(start.bcc);
  const [subject, setSubject] = createSignal(start.subject);
  const [text, setText] = createSignal(start.text);
  const [from, setFrom] = createSignal(start.from);
  const [busy, setBusy] = createSignal(false);
  const accounts = useAction<MailAccount[]>("mail.accounts");
  const choose = () => (accounts.data ?? []).length > 1 || !from();
  // A reply's recipients and subject come from the conversation: the message is what's left.
  const [more, setMore] = createSignal(!foldsExtras(first, props.conversation));
  const ccShown = showsCc(first, props.conversation);
  let message: HTMLTextAreaElement | undefined;
  /** The account Hearth has it going from: one named in a save must still be connected. */
  let savedFrom = first.account;
  /** The newest version known here, so this screen's own saves aren't read back. */
  let known = first.version;
  let read = false;

  const current = (): DraftFields => ({
    from: from(),
    to: to(),
    cc: cc(),
    bcc: bcc(),
    subject: subject(),
    text: text(),
  });
  const heard = (d: MailDraft) => {
    savedFrom = d.account;
    known = Math.max(known, d.version);
    return d.version;
  };
  const saver = createSaver<DraftFields>({
    id,
    key: `draft:${id}`,
    noun: "draft",
    action: "mail.draft_update",
    input: (d, baseVersion) => ({
      id,
      baseVersion,
      to: splitAddresses(d.to),
      cc: splitAddresses(d.cc),
      bcc: splitAddresses(d.bcc),
      subject: d.subject,
      text: d.text,
      // Only when you picked another: an account named here must still be connected.
      ...(d.from && d.from !== savedFrom ? { account: d.from } : {}),
    }),
    savedAs: (r) => heard(r as MailDraft),
    async get() {
      // The first read is the draft the page has already; after that, Hearth's copy.
      const d = read ? (await action<MailDraft[]>("mail.drafts", { id }))[0] : first;
      read = true;
      if (!d) throw new ApiError(404, "not_found", "No draft with that id.");
      return { title: d.subject, data: fieldsOf(d), version: heard(d) };
    },
    merge: mergeDraft,
    empty: () => ({ from: null, to: "", cc: "", bcc: "", subject: "", text: "" }),
    current,
    show(d) {
      setFrom(d.from);
      setTo(d.to);
      setCc(d.cc);
      setBcc(d.bcc);
      setSubject(d.subject);
      setText(d.text);
    },
  });
  onMount(() => void saver.load());
  // Changed elsewhere (Jarvis, another screen): the page's drafts have a newer version.
  createEffect(
    on(
      () => props.draft?.version,
      (v) => v !== undefined && v > known && void saver.load(),
      { defer: true },
    ),
  );
  onCleanup(() => void saver.close());

  // Reply was pressed for this draft: the cursor goes to the start of its message.
  createEffect(() => {
    if (cursorFor() !== id || !message) return;
    cursorPlaced();
    message.focus({ preventScroll: true });
    message.setSelectionRange(0, 0);
    message.scrollIntoView({ block: "nearest" });
  });

  const typed = (set: (v: string) => void) => (e: { currentTarget: { value: string } }) => {
    set(e.currentTarget.value);
    saver.changed();
  };

  const send = async () => {
    if (!from()) return toast.show("Pick which account it goes from first.");
    setBusy(true);
    try {
      const seen = current();
      const version = await saver.flush();
      if (version === null)
        return toast.show(
          `Nothing was sent. ${saver.problem() ?? "The draft isn't saved yet."}`,
          "error",
        );
      // A change made elsewhere was merged in as it saved: what would go isn't what you saw.
      if (!same(current(), seen))
        return toast.show(
          "The draft changed elsewhere as you pressed Send, so nothing was sent. Check it and send again.",
          "error",
        );
      const sent = await act<{ alreadySent?: boolean }>("mail.send", { id, version });
      if (sent) {
        // An earlier Send went out though Gmail didn't say so: that one stands, as it was then.
        toast.show(
          sent.alreadySent ? "It had already gone out, so it wasn't sent again." : "Sent.",
        );
        props.onDone?.();
      }
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    // Saved first, so Undo brings back what's on screen.
    await saver.flush();
    if (!(await act("mail.discard", { id }))) return;
    toast.show("Draft thrown away.", "info", {
      label: "Undo",
      run: () => void act("entity.restore", { id }),
    });
    props.onDone?.();
  };

  return (
    <form
      class="space-y-2 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Show when={choose()} fallback={<div class="text-xs text-muted">From {from()}</div>}>
        <label class="flex items-center gap-2 text-xs text-muted">
          From
          <select
            class="rounded-md border border-line bg-panel px-2 py-1 text-sm"
            aria-label="From"
            value={from() ?? ""}
            disabled={!saver.loaded()}
            onChange={(e) => {
              setFrom(e.currentTarget.value || null);
              saver.changed();
              void saver.flush();
            }}
          >
            <Show when={!from()}>
              <option value="">Pick an account</option>
            </Show>
            <For each={accounts.data ?? []}>
              {(a) => <option value={a.address}>{a.address}</option>}
            </For>
          </select>
        </label>
      </Show>
      {/* Until the first read (this page's copy, or one kept on this device), nothing is typed. */}
      <input
        class={field}
        aria-label="To"
        placeholder="To"
        value={to()}
        readOnly={!saver.loaded()}
        onInput={typed(setTo)}
      />
      {/* Who else it goes to is never hidden: a Cc with anyone on it stays out, even emptied. */}
      <Show when={more() || ccShown || cc().trim()}>
        <input
          class={field}
          aria-label="Cc"
          placeholder="Cc"
          value={cc()}
          readOnly={!saver.loaded()}
          onInput={typed(setCc)}
        />
      </Show>
      <Show
        when={more()}
        fallback={
          <button
            type="button"
            class="text-xs text-muted hover:text-ink"
            onClick={() => setMore(true)}
          >
            More: {ccShown || cc().trim() ? "" : "Cc, "}Bcc, Subject
          </button>
        }
      >
        <input
          class={field}
          aria-label="Bcc"
          placeholder="Bcc"
          value={bcc()}
          readOnly={!saver.loaded()}
          onInput={typed(setBcc)}
        />
        <input
          class={field}
          aria-label="Subject"
          placeholder="Subject"
          value={subject()}
          readOnly={!saver.loaded()}
          onInput={typed(setSubject)}
        />
      </Show>
      <textarea
        ref={message}
        class={`${field} min-h-40`}
        aria-label="Message"
        value={text()}
        readOnly={!saver.loaded()}
        onInput={typed(setText)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div class="flex items-center gap-2">
        <Button
          kind="primary"
          small
          disabled={busy() || !from() || !saver.loaded()}
          onClick={() => void send()}
        >
          Send
        </Button>
        <span class="flex-1 text-xs text-faint">
          <Show
            when={saver.problem()}
            fallback={
              from() ? "Ctrl+Enter sends. Saved as you type." : "Pick who it's from to send it."
            }
          >
            {(why) => <span class="text-bad">{why()}</span>}
          </Show>
        </span>
        <Button small kind="danger" onClick={() => void discard()}>
          Discard
        </Button>
      </div>
    </form>
  );
}
