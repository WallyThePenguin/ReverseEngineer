// Writing email: a draft saves itself as you type, and Send sends it. Drafts Jarvis wrote show up
// here too, ready to check and send. Send saves exactly what's on screen and sends only if the
// draft still matches it, so nothing you can't see (a change Jarvis made meanwhile) goes out.

import { createSignal, onCleanup } from "solid-js";
import { Button } from "../components/ui.tsx";
import { toast } from "../lib/live.ts";
import { act } from "../lib/query.ts";
import type { MailAddress, MailDraft } from "../lib/types.ts";

const field = "w-full rounded border border-line bg-panel px-2 py-1 text-sm";
const show = (xs: MailAddress[]) =>
  xs.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
const split = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function Composer(props: { draft: MailDraft; onDone?: () => void }) {
  const [to, setTo] = createSignal(show(props.draft.to));
  const [cc, setCc] = createSignal(show(props.draft.cc));
  const [bcc, setBcc] = createSignal(show(props.draft.bcc));
  const [subject, setSubject] = createSignal(props.draft.subject);
  const [text, setText] = createSignal(props.draft.text);
  const [busy, setBusy] = createSignal(false);
  let timer: number | undefined;
  let dirty = false;

  const save = async (always = false) => {
    window.clearTimeout(timer);
    if (!dirty && !always) return { snapshot: undefined };
    dirty = false;
    return act<{ snapshot: unknown }>("mail.draft_update", {
      id: props.draft.id,
      to: split(to()),
      cc: split(cc()),
      bcc: split(bcc()),
      subject: subject(),
      text: text(),
    });
  };
  const edited = () => {
    dirty = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void save(), 800);
  };
  onCleanup(() => void save());
  const typed = (set: (v: string) => void) => (e: { currentTarget: { value: string } }) => {
    set(e.currentTarget.value);
    edited();
  };

  const send = async () => {
    setBusy(true);
    try {
      const saved = await save(true);
      if (!saved) return;
      if (await act("mail.send", { id: props.draft.id, snapshot: saved.snapshot })) {
        toast.show("Sent.");
        props.onDone?.();
      }
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    window.clearTimeout(timer);
    dirty = false;
    if (await act("mail.discard", { id: props.draft.id })) props.onDone?.();
  };

  return (
    <form
      class="space-y-2 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div class="text-xs text-muted">From {props.draft.account}</div>
      <input class={field} aria-label="To" placeholder="To" value={to()} onInput={typed(setTo)} />
      <input class={field} aria-label="Cc" placeholder="Cc" value={cc()} onInput={typed(setCc)} />
      <input
        class={field}
        aria-label="Bcc"
        placeholder="Bcc"
        value={bcc()}
        onInput={typed(setBcc)}
      />
      <input
        class={field}
        aria-label="Subject"
        placeholder="Subject"
        value={subject()}
        onInput={typed(setSubject)}
      />
      <textarea
        class={`${field} min-h-40`}
        aria-label="Message"
        value={text()}
        onInput={typed(setText)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div class="flex items-center gap-2">
        <Button kind="primary" small disabled={busy()} onClick={() => void send()}>
          Send
        </Button>
        <span class="flex-1 text-xs text-faint">Ctrl+Enter sends. Saved as you type.</span>
        <Button small kind="danger" onClick={() => void discard()}>
          Discard
        </Button>
      </div>
    </form>
  );
}
