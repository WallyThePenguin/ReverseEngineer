// Settings > Sign-ins: the logins Jarvis may use to sign in by itself (D26). Passwords go in and
// never come back out: this page shows sites and usernames only.

import { createSignal, For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";

interface Login {
  id: string;
  site: string;
  username: string;
  lastUsedAt: string | null;
}

const field = "rounded border border-line bg-panel px-2 py-1 text-sm";

export function SignInSettings() {
  const logins = useAction<Login[]>("vault.logins");
  const [site, setSite] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");

  async function save(e: Event) {
    e.preventDefault();
    const saved = await act<Login>("vault.save", {
      site: site(),
      username: username(),
      password: password(),
    });
    // The password is cleared either way; it's never kept on this page.
    setPassword("");
    if (saved) {
      setSite("");
      setUsername("");
      toast.show(`Pip can sign in to ${saved.site} now.`);
    }
  }

  return (
    <section class="space-y-2">
      <h2 class="font-semibold">Sign-ins</h2>
      <p class="text-sm text-muted">
        Pip signs in to these sites by itself. It never sees the passwords: Nook types them into the
        matching site only, and two-step codes come to you. Leave out your bank, your email recovery
        and your password manager.
      </p>
      <ul class="space-y-1">
        <For each={logins.data ?? []}>
          {(l) => (
            <li class="flex items-center gap-3 rounded-md bg-sunk px-3 py-2 text-sm">
              <span class="font-medium">{l.site}</span>
              <span class="flex-1 text-muted">{l.username}</span>
              <span class="text-xs text-faint">
                {l.lastUsedAt ? `used ${ago(l.lastUsedAt)}` : "not used yet"}
              </span>
              <Button
                small
                kind="danger"
                onClick={async () => {
                  if (await act("vault.remove", { id: l.id })) toast.show(`Forgot ${l.site}.`);
                }}
              >
                Remove
              </Button>
            </li>
          )}
        </For>
      </ul>
      <Show when={(logins.data ?? []).length === 0}>
        <p class="text-sm text-faint">No sign-ins saved yet.</p>
      </Show>
      <form class="flex flex-wrap items-center gap-2" onSubmit={(e) => void save(e)}>
        <input
          class={field}
          placeholder="site, like example.com"
          aria-label="Site"
          value={site()}
          onInput={(e) => setSite(e.currentTarget.value)}
          required
        />
        <input
          class={field}
          placeholder="username or email"
          aria-label="Username"
          autocomplete="off"
          value={username()}
          onInput={(e) => setUsername(e.currentTarget.value)}
          required
        />
        <input
          class={field}
          type="password"
          placeholder="password"
          aria-label="Password"
          autocomplete="new-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          required
        />
        <Button kind="primary" onClick={(e) => void save(e)}>
          Save sign-in
        </Button>
      </form>
    </section>
  );
}
