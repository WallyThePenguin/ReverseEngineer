// Disconnecting a Google account asks first: its calendars and mail leave Hearth. Unsent drafts
// from it can stay, to send from another account; keeping them is the default.

import { createSignal, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import type { MailDraft } from "../lib/types.ts";

export function DisconnectGoogle(props: { email: string }) {
  const [asking, setAsking] = createSignal(false);
  const [keep, setKeep] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const drafts = useAction<MailDraft[]>("mail.drafts", () => ({}), asking);
  const unsent = () => (drafts.data ?? []).filter((d) => d.account === props.email).length;

  const disconnect = async () => {
    setBusy(true);
    try {
      // Kept unless you said otherwise, even if the drafts weren't counted yet.
      const done = await act<{ keptDrafts: number }>("google.disconnect", {
        email: props.email,
        keepDrafts: keep(),
      });
      if (!done) return;
      setAsking(false);
      toast.show(
        done.keptDrafts > 0
          ? `Disconnected ${props.email}. Its drafts are in Mail: pick who they're from to send them.`
          : `Disconnected ${props.email}.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show
      when={asking()}
      fallback={
        <Button small kind="danger" onClick={() => setAsking(true)}>
          Disconnect
        </Button>
      }
    >
      <div class="flex basis-full flex-wrap items-center gap-3 border-t border-line pt-2">
        <span class="flex-1 text-xs text-muted">
          Disconnect {props.email}? Its calendars and mail leave Hearth.
        </span>
        <Show when={unsent() > 0}>
          <label class="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={keep()}
              onChange={(e) => setKeep(e.currentTarget.checked)}
            />
            Keep {unsent() === 1 ? "my unsent draft" : `my ${unsent()} unsent drafts`}
          </label>
        </Show>
        <Button
          small
          kind="danger"
          disabled={busy() || drafts.isLoading}
          onClick={() => void disconnect()}
        >
          Disconnect
        </Button>
        <Button small onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
    </Show>
  );
}
