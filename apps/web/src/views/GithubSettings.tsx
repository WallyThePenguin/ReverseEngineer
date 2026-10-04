// Settings for GitHub: a read-only token and the repos to follow. A pull request that names a task
// (T-123) moves it to In Review when you open it and to Completed when it merges.

import { createSignal, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago, day } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import { ReplaceToken } from "./ReplaceToken.tsx";

interface Status {
  connected: boolean;
  login?: string;
  syncedAt?: string | null;
  lastError?: string | null;
  /** "revoked": the token stopped working, and nothing new comes in until it's replaced. */
  state?: "ok" | "failing" | "revoked";
  tokenExpiresAt?: string | null;
  repos: string[];
}

/** You're told a week ahead that the token stops working. */
const WEEK = 7 * 86_400_000;

/** When the token stops working, if that's within a week. */
function expiresSoon(s: Status): string | null {
  if (!s.tokenExpiresAt) return null;
  const at = new Date(s.tokenExpiresAt);
  return at.getTime() - Date.now() < WEEK ? day(at) : null;
}

/** GitHub's page for a new fine-grained token, read-only pull requests. */
const TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?name=Hearth&description=Hearth+reads+pull+requests&pull_requests=read";

const repoList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((r) =>
      r
        .trim()
        .replace(/^https:\/\/github\.com\//, "")
        .replace(/\/$/, ""),
    )
    .filter(Boolean);

export function GithubSettings() {
  const status = useAction<Status>("github.status");
  const [token, setToken] = createSignal("");
  const [repos, setRepos] = createSignal("");
  const [editing, setEditing] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);

  const disconnect = async () => {
    if (!confirm("Disconnect GitHub? Its pull requests leave Hearth; your tasks stay as they are."))
      return;
    if (await act("github.disconnect")) toast.show("GitHub is disconnected.");
  };

  const connect = async (e: Event) => {
    e.preventDefault();
    const r = await act<{ login: string }>("github.connect", {
      token: token().trim(),
      repos: repoList(repos()),
    });
    if (!r) return;
    setToken("");
    toast.show(`GitHub connected as ${r.login}. Pull requests come in within a few minutes.`);
  };

  const saveRepos = async (e: Event) => {
    e.preventDefault();
    if (await act("github.set_repos", { repos: repoList(repos()) })) {
      setEditing(false);
    }
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">GitHub</h2>
      <p class="text-sm text-muted">
        A pull request that names a task (like T-12, in its title, branch or description) is linked
        to it. The task moves to In Review when you open the pull request and to Completed when it
        merges. Hearth only reads GitHub.
      </p>
      <Show when={status.data}>
        {(s) => (
          <Show
            when={s().connected}
            fallback={
              <form class="space-y-2 rounded-md bg-sunk px-3 py-3 text-sm" onSubmit={connect}>
                <p>
                  <a
                    class="text-accent underline"
                    href={TOKEN_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Make a read-only token
                  </a>{" "}
                  for your repos, then paste it here with the repos to follow.
                </p>
                <input
                  type="password"
                  autocomplete="off"
                  class="w-full rounded border border-line bg-panel px-2 py-1"
                  placeholder="github_pat_…"
                  aria-label="GitHub token"
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                />
                <input
                  class="w-full rounded border border-line bg-panel px-2 py-1"
                  placeholder="owner/repo, owner/other-repo"
                  aria-label="GitHub repos"
                  value={repos()}
                  onInput={(e) => setRepos(e.currentTarget.value)}
                />
                <Button kind="primary" submit disabled={!token().trim() || !repos().trim()}>
                  Connect
                </Button>
              </form>
            }
          >
            <div class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
              <div class="flex-1">
                <p class="font-medium">{s().login}</p>
                <p class="text-sm text-muted">
                  {s().state === "revoked"
                    ? "GitHub stopped accepting Hearth's token, so nothing new comes in."
                    : s().lastError ||
                      `${s().repos.join(", ")}${s().syncedAt ? ` · read ${ago(s().syncedAt!)}` : ""}`}
                </p>
                <Show when={s().state !== "revoked" && expiresSoon(s())}>
                  {(when) => (
                    <p class="text-sm text-bad">
                      The token stops working {when()}. Paste a new one before then.
                    </p>
                  )}
                </Show>
              </div>
              <Button
                onClick={() => {
                  setRepos(s().repos.join(", "));
                  setEditing(!editing());
                }}
              >
                Repos
              </Button>
              <Button onClick={() => setReplacing(!replacing())}>New token</Button>
              <Button kind="danger" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
            <Show when={replacing() || s().state === "revoked" || expiresSoon(s())}>
              <ReplaceToken
                action="github.replace_token"
                label="GitHub"
                placeholder="github_pat_…"
                why={`Make a new token for ${s().login} and paste it here. Repos and pull requests read in stay.`}
                onDone={() => setReplacing(false)}
              />
            </Show>
            <Show when={editing()}>
              <form class="flex gap-2" onSubmit={saveRepos}>
                <input
                  class="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 text-sm"
                  aria-label="GitHub repos"
                  value={repos()}
                  onInput={(e) => setRepos(e.currentTarget.value)}
                />
                <Button kind="primary" submit>
                  Save
                </Button>
              </form>
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}
