// A small notice when Hearth changed under the open page: it was updated (reload to get the new
// version), or the server's database doesn't fit its code. Checks every few minutes while the page
// is in view, and when you come back to it.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { type Notice, noticeFor, pageBuild, type ServerBuild, watchBuild } from "../lib/version.ts";

export function UpdateNotice() {
  const [notice, setNotice] = createSignal<Notice>(null);
  const check = async () => {
    try {
      const res = await fetch("/api/health/deep", { cache: "no-store" });
      if (res.ok) setNotice(noticeFor(pageBuild(), (await res.json()) as ServerBuild));
    } catch {
      // Offline or restarting: nothing to say yet.
    }
  };
  onMount(() => {
    // The development server rebuilds as you go; there's nothing to reload into.
    if (!import.meta.env.DEV) onCleanup(watchBuild(() => void check()));
  });

  return (
    <Show when={notice()}>
      {(n) => (
        <div class="pointer-events-auto flex items-center gap-3 rounded-lg bg-ink px-4 py-2 text-sm text-bg shadow-lg">
          <Show
            when={n() === "updated"}
            fallback={
              <span>Hearth's database doesn't match its code. Run hearth doctor on your PC.</span>
            }
          >
            <span>Hearth was updated.</span>
            <button
              type="button"
              class="font-semibold underline underline-offset-2"
              onClick={() => location.reload()}
            >
              Reload
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}
