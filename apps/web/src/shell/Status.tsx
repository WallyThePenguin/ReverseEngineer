// What the app shows when Hearth is out of reach or something on screen broke: never a blank
// page or a "Loading…" that never ends, and it comes back by itself once it can.

import { createEffect, type JSX, onCleanup, Show } from "solid-js";
import { Notice } from "../components/kit/Notice.tsx";
import { UpdateNotice } from "../components/UpdateNotice.tsx";
import { Button } from "../components/ui.tsx";
import { degraded } from "../lib/degraded.ts";
import { backoff, live } from "../lib/live.ts";
import { reloadPage } from "../lib/version.ts";
import { tryAgain, ViewLoadError } from "./loadView.tsx";

/**
 * Tries again while `state` says the last try failed: after about a second, backing off to 30 s,
 * and at once when the device is back online or the app is back on screen. Returns a function
 * that tries now (a Retry button).
 */
export function useAutoRetry(state: () => "failed" | "trying" | "ok", retry: () => void) {
  let attempt = 0;
  let timer: number | undefined;
  const now = () => {
    if (state() !== "failed") return;
    window.clearTimeout(timer);
    retry();
  };
  createEffect(() => {
    window.clearTimeout(timer);
    const s = state();
    if (s === "ok") attempt = 0;
    if (s === "failed") timer = window.setTimeout(retry, backoff(attempt++));
  });
  const wake = () => {
    if (document.visibilityState !== "hidden") now();
  };
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);
  onCleanup(() => {
    window.clearTimeout(timer);
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake);
  });
  return now;
}

function Centered(props: { title: string; text: string; children: JSX.Element }) {
  return (
    <div class="flex h-full items-center justify-center p-6" role="alert">
      <div class="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6 shadow-sm">
        <div>
          <h1 class="text-xl font-semibold">{props.title}</h1>
          <p class="mt-1 text-sm text-muted">{props.text}</p>
        </div>
        <div class="flex gap-2">{props.children}</div>
      </div>
    </div>
  );
}

/** Starting up and Hearth can't be reached. */
export function Unreachable(props: { retry: () => void; trying: boolean }) {
  return (
    <Centered
      title="Can't reach Hearth"
      text="Your PC may be asleep, restarting or offline. Hearth will keep trying."
    >
      <Button kind="primary" disabled={props.trying} onClick={props.retry}>
        {props.trying ? "Trying…" : "Try again"}
      </Button>
    </Centered>
  );
}

/** Something on screen broke. Trying again redraws it; reloading starts the app afresh. */
export function Crashed(props: { error: unknown; reset: () => void }) {
  console.error(props.error);
  return (
    <Centered
      title="Something went wrong"
      text="This screen hit a problem. Try again, or reload Hearth if it keeps happening."
    >
      <Button kind="primary" onClick={props.reset}>
        Try again
      </Button>
      <Button onClick={() => reloadPage()}>Reload</Button>
    </Centered>
  );
}

/**
 * One pane broke: the rest of the app keeps working. A screen whose code couldn't load says why:
 * Hearth was updated (reload to open it), or the PC didn't answer (try again, which reloads the
 * page once the PC answers: a browser keeps a failed load).
 */
export function PaneCrashed(props: { error: unknown; reset: () => void }) {
  console.error(props.error);
  const why = () => (props.error instanceof ViewLoadError ? props.error.why : null);
  return (
    <div
      class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      role="alert"
    >
      <p class="text-sm text-muted">
        {why() === "updated"
          ? "Hearth was updated. Reload to open this."
          : why() === "offline"
            ? "Couldn't load this. Check your connection, then try again."
            : "This pane hit a problem."}
      </p>
      <div class="flex gap-2">
        <Show when={why() !== "updated"}>
          <Button
            small
            kind={why() ? "primary" : "plain"}
            onClick={() => (why() === "offline" ? void tryAgain(props.reset) : props.reset())}
          >
            Try again
          </Button>
        </Show>
        <Show when={why()}>
          <Button
            small
            kind={why() === "updated" ? "primary" : "plain"}
            onClick={() => reloadPage()}
          >
            Reload
          </Button>
        </Show>
      </div>
    </div>
  );
}

/**
 * Shown while Hearth answers but can't reach its database: what's on screen may be out of date.
 * It clears itself once a read works. (Hearth out of reach altogether is Reconnecting's.)
 */
function Degraded() {
  return (
    <Show when={degraded.on() && !live.reconnecting()}>
      <Notice tone="warn">
        Hearth can't get to your data right now, so what you see may be out of date. It catches up
        by itself.
      </Notice>
    </Show>
  );
}

/** Shown while the live connection to Hearth is down; it clears itself once it's back. */
function Reconnecting() {
  return (
    <Show when={live.reconnecting()}>
      <Notice icon="loader-circle" spin>
        Reconnecting…
      </Notice>
    </Show>
  );
}

/**
 * How Hearth is, at the top of the screen: one notice above the other, so an update notice never
 * hides "Reconnecting…". Clicks go through to the page, except on their buttons.
 */
export function Notices() {
  return (
    <div class="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2">
      <Reconnecting />
      <Degraded />
      <UpdateNotice />
    </div>
  );
}
