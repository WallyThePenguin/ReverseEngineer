// A notice when Hearth changed under the open page: it was updated (reload to get the new
// version), or an update on the PC didn't finish, so its database doesn't fit its code. Checks
// every few minutes while the page is in view, and when you come back to it. Opening or coming back
// to a page from before an update (it opens from the last page seen: sw.js), you get the new
// version at once, unless that would lose something or you've already started doing something
// on it.
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { live } from "../lib/live.ts";
import {
  type Notice as BuildNotice,
  markStarted,
  noticeFor,
  openedAt,
  pageBuild,
  reloadedFor,
  reloadInto,
  reloadOnReturn,
  reloadPage,
  type ServerBuild,
  watchBuild,
  wouldLoseWork,
} from "../lib/version.ts";
import { Notice } from "./kit/Notice.tsx";
import { Button } from "./ui.tsx";

/**
 * Asks which build is running when watchBuild says to, and moves the page on to a new one when
 * that loses nothing; otherwise `say` is told what to show. A check on opening or coming back that
 * Hearth didn't answer (restarting for an update) is still owed: the next check makes it, and
 * `owes` says whether to bring that forward (Hearth answers again). The small windows use this
 * without a notice (Mini.tsx).
 */
export function watchUpdates(say: (n: BuildNotice) => void = () => {}) {
  let owed: { idle: () => boolean; opening?: boolean } | null = null;
  const check = async (idle?: () => boolean, opening?: boolean) => {
    if (!idle && owed) ({ idle, opening } = owed);
    owed = null;
    let server: ServerBuild;
    try {
      const res = await fetch("/api/health/deep", { cache: "no-store" });
      if (!res.ok) throw new Error(`Hearth answered ${res.status}`);
      server = (await res.json()) as ServerBuild;
    } catch {
      // Offline or restarting: nothing to say yet.
      if (idle) owed = { idle, opening };
      return;
    }
    const now = noticeFor(pageBuild(), server);
    const lose = () => !idle?.() || wouldLoseWork();
    const into = idle ? reloadOnReturn(now, server, reloadedFor(), lose) : null;
    // Opening, it goes back to where it opened: the page may have tidied the address since.
    if (into) return reloadInto(into, opening ? openedAt : undefined);
    say(now);
  };
  // The development server rebuilds as you go; there's nothing to reload into.
  const stop = import.meta.env.DEV ? () => {} : watchBuild((idle, o) => void check(idle, o));
  return { check, stop, owes: () => owed !== null };
}

export function UpdateNotice() {
  const [notice, setNotice] = createSignal<BuildNotice>(null);
  const [checking, setChecking] = createSignal(false);
  let updates: ReturnType<typeof watchUpdates> | undefined;
  const checkAgain = async () => {
    setChecking(true);
    try {
      await updates?.check();
    } finally {
      setChecking(false);
    }
  };
  onMount(() => {
    // The app is up: this build opens from here next time (sw.js).
    markStarted();
    updates = watchUpdates(setNotice);
    onCleanup(updates.stop);
  });
  // Hearth answering again makes a check it couldn't answer before.
  createEffect(
    on(live.connected, (up) => {
      if (up && updates?.owes()) void updates.check();
    }),
  );

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
                <Button small disabled={checking()} onClick={() => void checkAgain()}>
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
              <Button small onClick={() => reloadPage()}>
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
