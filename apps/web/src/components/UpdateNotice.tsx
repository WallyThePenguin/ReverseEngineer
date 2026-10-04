// A small notice when Hearth changed under the open page: it was updated (reload to get the new
// version), or the server's database doesn't fit its code. Checks every few minutes, and when you
// come back to the page.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { type Notice, noticeFor, pageBuild, type ServerBuild } from "../lib/version.ts";

const EVERY_MS = 5 * 60_000;

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
    if (import.meta.env.DEV) return;
    void check();
    const timer = setInterval(check, EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    onCleanup(() => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
    });
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
