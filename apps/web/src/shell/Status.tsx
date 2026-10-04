// What the app shows when Hearth is out of reach or something on screen broke: never a blank
// page or a "Loading…" that never ends, and it comes back by itself once it can.

import { createEffect, type JSX, onCleanup, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { backoff, live } from "../lib/live.ts";

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
      <Button onClick={() => location.reload()}>Reload</Button>
    </Centered>
  );
}

/** One pane broke: the rest of the app keeps working. */
export function PaneCrashed(props: { error: unknown; reset: () => void }) {
  console.error(props.error);
  return (
    <div
      class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      role="alert"
    >
      <p class="text-sm text-muted">This pane hit a problem.</p>
      <Button small onClick={props.reset}>
        Try again
      </Button>
    </div>
  );
}

/**
 * Shown while the live connection to Hearth is down; it clears itself once it's back. The shell
 * places it, above an update notice.
 */
export function Reconnecting() {
  return (
    <Show when={live.reconnecting()}>
      <div class="rounded-full bg-ink px-4 py-1.5 text-sm text-bg shadow-lg" role="status">
        Reconnecting…
      </div>
    </Show>
  );
}
