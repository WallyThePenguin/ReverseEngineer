// Writing email: a draft saves itself as you type, and Send sends it. Drafts Jarvis wrote show up
// here too, ready to check and send.

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
  const [subject, setSubject] = createSignal(props.draft.subject);
  const [text, setText] = createSignal(props.draft.text);
  const [busy, setBusy] = createSignal(false);
  let timer: number | undefined;
  let dirty = false;

  const save = async () => {
    window.clearTimeout(timer);
    if (!dirty) return true;
    dirty = false;
    return (
      (await act("mail.draft_update", {
        id: props.draft.id,
        to: split(to()),
        cc: split(cc()),
        subject: subject(),
        text: text(),
      })) !== null
    );
  };
  const edited = () => {
    dirty = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void save(), 800);
  };
  onCleanup(() => void save());

  const send = async () => {
    setBusy(true);
    try {
      if (!(await save())) return;
      if (await act("mail.send", { id: props.draft.id })) {
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
      <input
        class={field}
        aria-label="To"
        placeholder="To"
        value={to()}
        onInput={(e) => (setTo(e.currentTarget.value), edited())}
      />
      <input
        class={field}
        aria-label="Cc"
        placeholder="Cc"
        value={cc()}
        onInput={(e) => (setCc(e.currentTarget.value), edited())}
      />
      <input
        class={field}
        aria-label="Subject"
        placeholder="Subject"
        value={subject()}
        onInput={(e) => (setSubject(e.currentTarget.value), edited())}
      />
      <textarea
        class={`${field} min-h-40`}
        aria-label="Message"
        value={text()}
        onInput={(e) => (setText(e.currentTarget.value), edited())}
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
