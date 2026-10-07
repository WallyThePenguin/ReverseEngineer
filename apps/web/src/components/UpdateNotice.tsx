// A notice when Hearth changed under the open page: it was updated (reload to get the new
// version), or an update on the PC didn't finish, so its database doesn't fit its code. Checks
// every few minutes while the page is in view, and when you come back to it. Opening or coming back
// to a page from before an update (it opens from the last page seen: sw.js), you get the new
// version at once, unless that would lose something or you've already started doing something
// on it.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  type Notice as BuildNotice,
  noticeFor,
  pageBuild,
  reloadedFor,
  reloadInto,
  reloadOnReturn,
  type ServerBuild,
  watchBuild,
  wouldLoseWork,
} from "../lib/version.ts";
import { Notice } from "./kit/Notice.tsx";
import { Button } from "./ui.tsx";

export function UpdateNotice() {
  const [notice, setNotice] = createSignal<BuildNotice>(null);
  const [checking, setChecking] = createSignal(false);
  // `idle` when the page has just come back into view (watchBuild).
  const check = async (idle?: () => boolean) => {
    setChecking(true);
    try {
      const res = await fetch("/api/health/deep", { cache: "no-store" });
      if (!res.ok) return;
      const server = (await res.json()) as ServerBuild;
      const now = noticeFor(pageBuild(), server);
      const lose = () => !idle?.() || wouldLoseWork();
      const into = idle ? reloadOnReturn(now, server, reloadedFor(), lose) : null;
      if (into) return reloadInto(into);
      setNotice(now);
    } catch {
      // Offline or restarting: nothing to say yet.
    } finally {
      setChecking(false);
    }
  };
  onMount(() => {
    // The development server rebuilds as you go; there's nothing to reload into.
    if (!import.meta.env.DEV) onCleanup(watchBuild((idle) => void check(idle)));
  });

  return (
    <Show when={notice()}>
      {(n) => (
        <Show
          when={n() === "updated"}
          fallback={
            // `hearth doctor` says what's wrong on the PC; here it's said in plain words.
            <Notice
              tone="bad"
              action={
                <Button small disabled={checking()} onClick={() => void check()}>
                  {checking() ? "Checking…" : "Check again"}
                </Button>
              }
            >
              Hearth on your PC didn't finish its last update, so some things may not work. Updating
              it again usually fixes this.
            </Notice>
          }
        >
          <Notice
            tone="info"
            action={
              <Button small onClick={() => location.reload()}>
                Reload
              </Button>
            }
          >
            Hearth was updated.
          </Notice>
        </Show>
      )}
    </Show>
  );
}
