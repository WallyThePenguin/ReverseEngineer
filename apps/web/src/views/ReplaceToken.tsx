// A new token for a connector that's already connected (Slack, GitHub). Everything it read in
// stays; syncing carries on with the new token (D61).

import { createSignal, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { toast } from "../lib/live.ts";
import { act } from "../lib/query.ts";

export function ReplaceToken(props: {
  /** The action that takes the token: slack.replace_token, github.replace_token. */
  action: string;
  /** Slack, GitHub. */
  label: string;
  placeholder: string;
  /** Why a new token is wanted, when there's a reason to say. */
  why?: string;
  onDone?: () => void;
}) {
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const r = await act(props.action, { token: token().trim() });
    setBusy(false);
    if (!r) return;
    setToken("");
    toast.show(`${props.label} has its new token. Syncing carries on.`);
    props.onDone?.();
  };

  return (
    <form class="space-y-2 rounded-md border border-line px-3 py-2 text-sm" onSubmit={save}>
      <Show when={props.why}>
        <p>{props.why}</p>
      </Show>
      <div class="flex gap-2">
        <input
          type="password"
          autocomplete="off"
          class="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1"
          placeholder={props.placeholder}
          aria-label={`New ${props.label} token`}
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
        />
        <Button kind="primary" submit disabled={busy() || !token().trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
