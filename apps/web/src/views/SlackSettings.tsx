// Settings for Slack: make a small Slack app from a ready-made manifest, paste its token, and pick
// which channels are read in. Hearth only reads; it never posts.

import { createSignal, For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import { ReplaceToken } from "./ReplaceToken.tsx";

interface Status {
  connected: boolean;
  team?: string;
  syncedAt?: string | null;
  lastError?: string | null;
  /** "revoked": the token stopped working, and nothing new comes in until it's replaced. */
  state?: "ok" | "failing" | "revoked";
  scopes: string[];
}

interface Channel {
  id: string;
  name: string;
  kind: "channel" | "private" | "group" | "dm";
  ingest: boolean;
}

/** Opens Slack's "create an app" page with Hearth's app already filled in. */
function manifestUrl(scopes: string[]) {
  const manifest = {
    display_information: {
      name: "Hearth",
      description: "Reads your Slack into Hearth. Never posts.",
    },
    oauth_config: { scopes: { user: scopes } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false },
  };
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

const KIND = { channel: "#", private: "🔒 ", group: "👥 ", dm: "@" } as const;

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
    if (await act("slack.disconnect")) toast.show("Slack is disconnected.");
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Slack</h2>
      <p class="text-sm text-muted">
        Your team's Slack, read in: @mentions and direct messages land in the inbox, and Jarvis can
        look things up. Hearth never posts. What people write there is treated as outside content.
      </p>
      <Show when={status.data}>
        {(s) => (
          <Show
            when={s().connected}
            fallback={
              <form class="space-y-2 rounded-md bg-sunk px-3 py-3 text-sm" onSubmit={connect}>
                <ol class="list-decimal space-y-1 pl-5">
                  <li>
                    <a
                      class="text-accent underline"
                      href={manifestUrl(s().scopes)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Create Hearth's Slack app
                    </a>{" "}
                    in your workspace (it's filled in already), then press Install to Workspace.
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
                            void act("slack.set_channel", {
                              id: c.id,
                              ingest: e.currentTarget.checked,
                            })
                          }
                        />
                        <span>
                          {KIND[c.kind]}
                          {c.name}
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
          </Show>
        )}
      </Show>
    </section>
  );
}
