// Settings for Slack: set up your Slack app from the manifest Hearth makes, paste your token, and
// pick which channels are read in. Your token only reads; Jarvis posts as its own bot, set up
// below once Slack is connected (D62).

import { createSignal, For, Show } from "solid-js";
import { Icon, type IconName } from "../components/icons.tsx";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { orBack } from "../lib/orBack.ts";
import { act, useAction } from "../lib/query.ts";
import { ReplaceToken } from "./ReplaceToken.tsx";
import {
  type LeftBehind,
  leftBehind,
  SlackBotSettings,
  SlackManifest,
} from "./SlackBotSettings.tsx";

interface Status {
  connected: boolean;
  team?: string;
  syncedAt?: string | null;
  lastError?: string | null;
  /** "revoked": the token stopped working, and nothing new comes in until it's replaced. */
  state?: "ok" | "failing" | "revoked";
  scopes: string[];
  /** The manifest for your Slack app: your token's reading list and Jarvis's bot (D62). */
  manifest: string;
}

interface Channel {
  id: string;
  name: string;
  kind: "channel" | "private" | "group" | "dm";
  ingest: boolean;
}

/** What kind of conversation a channel is, by its icon and in words for a screen reader. */
const KIND: Record<Channel["kind"], { icon: IconName; label: string }> = {
  channel: { icon: "hash", label: "channel" },
  private: { icon: "lock", label: "private channel" },
  group: { icon: "users", label: "group message" },
  dm: { icon: "at-sign", label: "direct message" },
};

export function SlackSettings() {
  const status = useAction<Status>("slack.status");
  const channels = useAction<Channel[]>("slack.channels");
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [showChannels, setShowChannels] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);

  const connect = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const r = await act<{ team: string }>("slack.connect", { token: token().trim() });
    setBusy(false);
    if (!r) return;
    setToken("");
    toast.show(`Slack connected: ${r.team}. Messages start coming in within a few minutes.`);
  };

  const disconnect = async () => {
    if (!confirm("Disconnect Slack? Its messages leave Hearth.")) return;
    const r = await act<LeftBehind>("slack.disconnect");
    if (r) toast.show(`Slack is disconnected.${leftBehind(r)}`);
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Slack</h2>
      <p class="text-sm text-muted">
        Your team's Slack, read in with your own token: @mentions and direct messages land in the
        inbox, and Jarvis can look things up. Hearth never posts as you. What people write there is
        treated as outside content.
      </p>
      <Show when={status.data}>
        {(s) => (
          <Show
            when={s().connected}
            fallback={
              <form class="space-y-2 rounded-md bg-sunk px-3 py-3 text-sm" onSubmit={connect}>
                <SlackManifest text={s().manifest} />
                <ol class="list-decimal space-y-1 pl-5">
                  <li>
                    In your Slack app, open App Manifest, switch to YAML and merge this in, keeping
                    your app id and redirect settings. Then install or reinstall it to the
                    workspace.
                  </li>
                  <li>Copy its User OAuth Token (it starts with xoxp-) and paste it here.</li>
                </ol>
                <div class="flex gap-2">
                  <input
                    type="password"
                    autocomplete="off"
                    class="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1"
                    placeholder="xoxp-…"
                    aria-label="Slack user token"
                    value={token()}
                    onInput={(e) => setToken(e.currentTarget.value)}
                  />
                  <Button kind="primary" submit disabled={busy() || !token().trim()}>
                    Connect
                  </Button>
                </div>
              </form>
            }
          >
            <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
              <div class="flex-1">
                <p class="font-medium">{s().team}</p>
                <p class="text-sm text-muted">
                  {s().state === "revoked"
                    ? "Slack stopped accepting Hearth's token, so nothing new comes in."
                    : s().lastError
                      ? s().lastError
                      : s().syncedAt
                        ? `Read in ${ago(s().syncedAt!)}.`
                        : "Reading in your channels…"}
                </p>
              </div>
              <Button onClick={() => setShowChannels(!showChannels())}>Channels</Button>
              <Button onClick={() => setReplacing(!replacing())}>New token</Button>
              <Button kind="danger" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
            <Show when={replacing() || s().state === "revoked"}>
              <ReplaceToken
                action="slack.replace_token"
                label="Slack"
                placeholder="xoxp-…"
                why="Paste a new User OAuth Token from the same Slack app. Everything read in stays."
                onDone={() => setReplacing(false)}
              />
            </Show>
            <Show when={showChannels()}>
              <ul class="max-h-72 space-y-1 overflow-auto rounded-md border border-line px-3 py-2 text-sm">
                <For each={channels.data ?? []}>
                  {(c) => (
                    <li>
                      <label class="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={c.ingest}
                          onChange={(e) =>
                            void orBack(
                              e.currentTarget,
                              act("slack.set_channel", {
                                id: c.id,
                                ingest: e.currentTarget.checked,
                              }),
                              () => c.ingest,
                            )
                          }
                        />
                        <span class="flex min-w-0 items-center gap-1.5">
                          <Icon name={KIND[c.kind].icon} size={14} class="text-muted" />
                          {c.name}
                          <span class="sr-only">, {KIND[c.kind].label}</span>
                        </span>
                      </label>
                    </li>
                  )}
                </For>
              </ul>
              <p class="text-xs text-muted">
                Unticked channels aren't read in, but mentions of you there still come through.
              </p>
            </Show>
            <SlackBotSettings manifest={s().manifest} />
          </Show>
        )}
      </Show>
    </section>
  );
}
