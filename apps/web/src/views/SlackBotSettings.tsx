// Settings for Jarvis's own Slack bot (D62): the manifest to merge into your Slack app, the bot's
// two tokens, how its socket is doing, who it answers (SlackMembers.tsx), the channels it answers
// in and what your own DM gets back (SlackChannels.tsx). Jarvis posts only as the bot, never as
// you, and nobody in the workspace can talk to it until you turn members on.

import { createSignal, For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import { OwnerDmSwitch, SlackChannels } from "./SlackChannels.tsx";
import { MemberSwitches, SlackMembers } from "./SlackMembers.tsx";

/** What a disconnect did with posts Jarvis hadn't finished, as the toast says it. */
export interface LeftBehind {
  unsent: number;
  unsure: number;
}

export function leftBehind(r: LeftBehind): string {
  const n = (k: number) => `${k} message${k === 1 ? "" : "s"}`;
  const said = [
    ...(r.unsent ? [`${n(r.unsent)} it hadn't sent won't go out`] : []),
    ...(r.unsure ? [`${n(r.unsure)} may already have gone out`] : []),
  ];
  return said.length ? ` ${said.join(", and ")}; your inbox lists them.` : "";
}

interface BotStatus {
  connected: boolean;
  appId: string;
  botUser?: string;
  /** "revoked": Slack revoked its tokens; nothing is heard or sent until new ones are pasted. */
  state?: "ok" | "failing" | "revoked";
  lastError?: string | null;
  /** When its socket was last connected. */
  syncedAt?: string | null;
  /** False when another copy of Hearth connected it: only that copy listens. */
  listensHere?: boolean | null;
  membersOn: boolean;
  /** "Jarvis answers members on its own": its DM replies go out without your yes. */
  answersOnOwn: boolean;
  /** What your own DM to Jarvis gets back in Slack: fixed replies, or the answer (D62). */
  ownerDmAnswers: "fixed" | "full";
}

/** The manifest to merge into your Slack app, with a button that copies it. */
export function SlackManifest(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  const copy = () =>
    void navigator.clipboard
      .writeText(props.text)
      .then(() => setCopied(true))
      .catch(() => {});
  return (
    <div class="space-y-1">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-muted">App manifest (YAML)</span>
        <Button small onClick={copy}>
          {copied() ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre class="max-h-60 overflow-auto rounded border border-line bg-panel p-2 font-mono text-xs whitespace-pre">
        {props.text}
      </pre>
    </div>
  );
}

/** The bot's two tokens, to connect it or to give it new ones. */
function TokensForm(props: {
  action: "slack.bot_connect" | "slack.bot_replace_tokens";
  label: string;
  onDone: (warnings: string[]) => void;
}) {
  const [bot, setBot] = createSignal("");
  const [app, setApp] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const r = await act<{ warnings: string[] }>(props.action, {
      botToken: bot().trim(),
      appToken: app().trim(),
    });
    setBusy(false);
    if (!r) return;
    setBot("");
    setApp("");
    props.onDone(r.warnings);
  };
  const field = "min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1";
  return (
    <form class="flex flex-col gap-2 md:flex-row" onSubmit={save}>
      <input
        type="password"
        autocomplete="off"
        class={field}
        placeholder="Bot token, xoxb-…"
        aria-label="The Jarvis bot's token"
        value={bot()}
        onInput={(e) => setBot(e.currentTarget.value)}
      />
      <input
        type="password"
        autocomplete="off"
        class={field}
        placeholder="App token, xapp-…"
        aria-label="The Jarvis bot's app token"
        value={app()}
        onInput={(e) => setApp(e.currentTarget.value)}
      />
      <Button kind="primary" submit disabled={busy() || !bot().trim() || !app().trim()}>
        {props.label}
      </Button>
    </form>
  );
}

function state(s: BotStatus): string {
  if (s.state === "revoked") return "Slack revoked the Jarvis bot's tokens, so it isn't listening.";
  if (s.listensHere === false)
    return "Another copy of Nook connected the bot, and only that one listens. Paste the tokens here to move it.";
  if (s.lastError) return s.lastError;
  if (s.syncedAt) return `Listening. Last connected ${ago(s.syncedAt)}.`;
  return "Connected. Nook listens once its socket is up.";
}

export function SlackBotSettings(props: { manifest: string }) {
  const status = useAction<BotStatus>("slack.bot_status");
  const [replacing, setReplacing] = createSignal(false);
  const [warnings, setWarnings] = createSignal<string[]>([]);

  const done = (said: string) => (w: string[]) => {
    setWarnings(w);
    setReplacing(false);
    toast.show(said);
  };
  const disconnect = async () => {
    if (!confirm("Disconnect the Jarvis bot? Its tokens leave Nook and it stops listening."))
      return;
    const r = await act<LeftBehind>("slack.bot_disconnect");
    if (r) toast.show(`The Jarvis bot is disconnected.${leftBehind(r)}`);
  };

  return (
    <div class="space-y-2 rounded-md border border-line px-3 py-3 text-sm">
      <h3 class="font-medium">The Jarvis bot in Slack</h3>
      <p class="text-muted">
        People in your workspace can DM Pip's own bot in Slack, called Jarvis, and it answers as
        Jarvis, never as you. It only ever shares what you've written down to share.
      </p>
      <Show when={status.data}>
        {(s) => (
          <Show
            when={s().connected}
            fallback={
              <div class="space-y-2">
                <SlackManifest text={props.manifest} />
                <ol class="list-decimal space-y-1 pl-5">
                  <li>
                    Merge this manifest into the Jarvis app ({s().appId}). It turns on Socket Mode
                    and the Messages tab and gives the bot its five scopes. Leave Interactivity and
                    Token Rotation off.
                  </li>
                  <li>
                    Under Basic Information → App-Level Tokens, generate a token named hearth-socket
                    with the connections:write scope.
                  </li>
                  <li>
                    Under OAuth & Permissions, reinstall the app, then copy the Bot User OAuth
                    Token.
                  </li>
                  <li>Paste both tokens here.</li>
                </ol>
                <TokensForm
                  action="slack.bot_connect"
                  label="Connect"
                  onDone={done("The Jarvis bot is connected.")}
                />
              </div>
            }
          >
            <div class="flex items-center gap-3">
              <div class="flex-1">
                <p class="font-medium">Connected as {s().botUser}</p>
                <p class="text-muted">{state(s())}</p>
                <Show when={!s().membersOn}>
                  <p class="text-faint">Nobody in the workspace can talk to it yet.</p>
                </Show>
              </div>
              <Button onClick={() => setReplacing(!replacing())}>New tokens</Button>
              <Button kind="danger" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
            <Show when={replacing() || s().state === "revoked" || s().listensHere === false}>
              <TokensForm
                action="slack.bot_replace_tokens"
                label="Save"
                onDone={done("The Jarvis bot has its new tokens.")}
              />
            </Show>
            <MemberSwitches membersOn={s().membersOn} answersOnOwn={s().answersOnOwn} />
            <OwnerDmSwitch ownerDmAnswers={s().ownerDmAnswers} />
            <SlackMembers />
            <SlackChannels />
          </Show>
        )}
      </Show>
      <Show when={warnings().length > 0}>
        <ul class="list-disc space-y-1 pl-5 text-warn">
          <For each={warnings()}>{(w) => <li>{w}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}
