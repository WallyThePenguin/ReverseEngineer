// Settings for data connectors (D73): a Convex deployment Jarvis may read when asked, with a deploy
// key you give Hearth, sealed. A deploy key is an admin key there, so a dev or preview one is the
// better choice; what Jarvis reads counts as outside content.

import { createSignal, For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";

interface Source {
  id: string;
  label: string;
  address: string;
  /** "production deploy key", "development deploy key"… */
  keyKind: string;
  checkedAt: string | null;
  /** What keeps Hearth from reading it, in Convex's words or Hearth's. */
  lastError: string | null;
}

const field = "w-full rounded border border-line bg-panel px-2 py-1";

export function DataSettings() {
  const sources = useAction<Source[]>("data.status");
  const [label, setLabel] = createSignal("");
  const [address, setAddress] = createSignal("");
  const [key, setKey] = createSignal("");

  const connect = async (e: Event) => {
    e.preventDefault();
    const r = await act<{ label: string; keyKind: string; production: boolean }>("data.connect", {
      label: label().trim(),
      address: address().trim(),
      key: key().trim(),
    });
    if (!r) return;
    setLabel("");
    setAddress("");
    setKey("");
    toast.show(
      r.production
        ? `${r.label} is connected with a production key. Jarvis only reads it, but a dev or preview key would be safer.`
        : `${r.label} is connected. Jarvis can read it when you ask.`,
    );
  };
  const check = async (s: Source) => {
    const r = await act<{ ok: boolean; problem: string | null }>("data.check", { source: s.id });
    if (r) toast.show(r.ok ? `${s.label}'s key works.` : `${s.label}: ${r.problem}`);
  };
  const forget = async (s: Source) => {
    if (!confirm(`Forget ${s.label}? Jarvis stops reading it; nothing changes in Convex.`)) return;
    if (await act("data.disconnect", { source: s.id })) toast.show(`${s.label} is forgotten.`);
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Data sources</h2>
      <p class="text-sm text-muted">
        Jarvis can read a Convex deployment when you ask: its tables, their documents, and its own
        query functions, which only read. What Jarvis reads is treated like mail from outside, so
        anything it would send after reading it asks you first.
      </p>
      <Show when={sources.data?.length}>
        <ul class="space-y-2">
          <For each={sources.data}>
            {(s) => (
              <li class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
                <div class="min-w-0 flex-1">
                  <p class="truncate font-medium">
                    {s.label}
                    <span class="text-muted"> · {s.address.replace(/^https?:\/\//, "")}</span>
                  </p>
                  <p class={`text-sm ${s.lastError ? "text-bad" : "text-muted"}`}>
                    {s.lastError ??
                      `Reads only, with a ${s.keyKind}${s.checkedAt ? ` · checked ${ago(s.checkedAt)}` : ""}`}
                  </p>
                </div>
                <Button onClick={() => void check(s)}>Check</Button>
                <Button kind="danger" onClick={() => void forget(s)}>
                  Forget
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form class="space-y-2 rounded-md bg-sunk px-3 py-3 text-sm" onSubmit={connect}>
        <label class="block">
          <span class="text-muted">Name, as you'll call it to Jarvis</span>
          <input
            class={field}
            placeholder="Shop"
            maxLength={60}
            value={label()}
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
        </label>
        <label class="block">
          <span class="text-muted">Deployment URL</span>
          <input
            class={field}
            placeholder="https://happy-otter-123.convex.cloud"
            value={address()}
            onInput={(e) => setAddress(e.currentTarget.value)}
          />
        </label>
        <label class="block">
          <span class="text-muted">Deploy key</span>
          <input
            type="password"
            autocomplete="off"
            class={field}
            placeholder="dev:happy-otter-123|…"
            aria-label="Deploy key"
            value={key()}
            onInput={(e) => setKey(e.currentTarget.value)}
          />
        </label>
        <p class="text-muted">
          A deploy key is an admin key: it could change anything in that deployment. Hearth only
          reads with it and keeps it sealed, but give it a development or preview deployment's key
          where you can. Make one in the Convex dashboard, under the deployment's Settings.
        </p>
        <Button
          kind="primary"
          submit
          disabled={!label().trim() || !address().trim() || !key().trim()}
        >
          Connect
        </Button>
      </form>
    </section>
  );
}
