// Settings for Notion tasks (D68): paste an internal integration's secret, pick your task board
// and who you are on it. The tickets assigned to you come in every few minutes, and Jarvis makes
// your tasks from them. Hearth only reads Notion.

import { createEffect, createSignal, For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import { ReplaceToken } from "./ReplaceToken.tsx";

interface Status {
  connected: boolean;
  workspace?: string | null;
  board?: string | null;
  boardId?: string | null;
  you?: string | null;
  open?: number;
  syncedAt?: string | null;
  lastError?: string | null;
  /** "revoked": the secret stopped working, and nothing new comes in until it's replaced. */
  state?: "ok" | "failing" | "revoked";
}

interface Choices {
  boards: { id: string; title: string }[];
  people: { id: string; name: string }[];
  you: string | null;
}

const INTEGRATIONS_URL = "https://www.notion.so/profile/integrations";
const field = "w-full rounded border border-line bg-panel px-2 py-1";

/** How syncing is going, in a line. */
function line(s: Status): string {
  if (s.state === "revoked")
    return "Notion stopped accepting Nook's secret, so nothing new comes in.";
  if (s.lastError) return s.lastError;
  const open = `${s.open ?? 0} open ticket${s.open === 1 ? "" : "s"} for you`;
  return `${open}${s.syncedAt ? ` · read ${ago(s.syncedAt)}` : " · reading soon"}`;
}

function Chooser(props: { current: Status; onDone: () => void }) {
  const choices = useAction<Choices>("notion.choices");
  const [board, setBoard] = createSignal(props.current.boardId ?? "");
  const [you, setYou] = createSignal("");
  createEffect(() => {
    const c = choices.data;
    if (!c) return;
    if (!board() && c.boards.length === 1) setBoard(c.boards[0]!.id);
    if (!you() && c.you) setYou(c.you);
  });
  const save = async (e: Event) => {
    e.preventDefault();
    const r = await act<{ board: string; you: string | null }>("notion.choose", {
      board: board(),
      you: you() || null,
    });
    if (!r) return;
    toast.show(`Reading ${r.board}. Your open tickets come in within a few minutes.`);
    props.onDone();
  };
  return (
    <form class="space-y-2 rounded-md bg-sunk px-3 py-3 text-sm" onSubmit={save}>
      <Show when={choices.data} fallback={<p class="text-muted">Asking Notion…</p>}>
        {(c) => (
          <Show
            when={c().boards.length}
            fallback={
              <p>
                Notion shows Nook no databases yet. In Notion, open your task board, then ••• →
                Connections, and add your Nook integration.
              </p>
            }
          >
            <label class="block">
              <span class="text-muted">Task board</span>
              <select
                class={field}
                value={board()}
                onChange={(e) => setBoard(e.currentTarget.value)}
              >
                <option value="">Pick one…</option>
                <For each={c().boards}>{(b) => <option value={b.id}>{b.title}</option>}</For>
              </select>
            </label>
            <label class="block">
              <span class="text-muted">You in Notion (tickets assigned to you come in)</span>
              <select class={field} value={you()} onChange={(e) => setYou(e.currentTarget.value)}>
                <option value="">Pick yourself…</option>
                <For each={c().people}>{(p) => <option value={p.id}>{p.name}</option>}</For>
              </select>
            </label>
            <Button kind="primary" submit disabled={!board()}>
              Save
            </Button>
          </Show>
        )}
      </Show>
    </form>
  );
}

export function NotionSettings() {
  const status = useAction<Status>("notion.status");
  const [token, setToken] = createSignal("");
  const [choosing, setChoosing] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);

  const connect = async (e: Event) => {
    e.preventDefault();
    const r = await act<{ workspace: string | null }>("notion.connect", { token: token().trim() });
    if (!r) return;
    setToken("");
    toast.show(
      `Notion connected${r.workspace ? ` to ${r.workspace}` : ""}. Now pick your task board.`,
    );
  };
  const disconnect = async () => {
    if (!confirm("Disconnect Notion? Its tickets leave Nook; your tasks stay as they are.")) return;
    if (await act("notion.disconnect")) toast.show("Notion is disconnected.");
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Notion</h2>
      <p class="text-sm text-muted">
        The tickets assigned to you on your Notion task board come in every few minutes, and Pip
        keeps a task for each open one, closed when the ticket is done. Nook only reads Notion.
      </p>
      <Show when={status.data}>
        {(s) => (
          <Show
            when={s().connected}
            fallback={
              <form class="space-y-2 rounded-md bg-sunk px-3 py-3 text-sm" onSubmit={connect}>
                <ol class="list-decimal space-y-1 pl-5">
                  <li>
                    At{" "}
                    <a
                      class="text-accent underline"
                      href={INTEGRATIONS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Notion's integrations
                    </a>
                    , make a new internal integration named Nook. Give it Read content and Read user
                    information including email addresses, nothing else.
                  </li>
                  <li>In Notion, open your task board, then ••• → Connections, and add Nook.</li>
                  <li>Copy the integration's secret and paste it here.</li>
                </ol>
                <input
                  type="password"
                  autocomplete="off"
                  class={field}
                  placeholder="ntn_…"
                  aria-label="Notion integration secret"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                />
                <Button kind="primary" submit disabled={!token().trim()}>
                  Connect
                </Button>
              </form>
            }
          >
            <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
              <div class="min-w-0 flex-1">
                <p class="font-medium">
                  {s().board ?? s().workspace ?? "Notion"}
                  <Show when={s().you}>
                    {(you) => <span class="text-muted"> · you are {you()}</span>}
                  </Show>
                </p>
                <p class={`text-sm ${s().state === "ok" ? "text-muted" : "text-bad"}`}>
                  {s().boardId ? line(s()) : "Pick your task board to start."}
                </p>
              </div>
              <Button onClick={() => setChoosing(!choosing())}>Board</Button>
              <Button onClick={() => setReplacing(!replacing())}>New secret</Button>
              <Button kind="danger" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
            <Show when={choosing() || !s().boardId}>
              <Chooser current={s()} onDone={() => setChoosing(false)} />
            </Show>
            <Show when={replacing() || s().state === "revoked"}>
              <ReplaceToken
                action="notion.replace_token"
                label="Notion"
                placeholder="ntn_…"
                why="Paste the Nook integration's secret again (Notion shows it under the integration). The board and tickets read in stay."
                onDone={() => setReplacing(false)}
              />
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}
