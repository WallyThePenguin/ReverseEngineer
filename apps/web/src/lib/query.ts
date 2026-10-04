// Reading and writing through actions, cached and refreshed by live events.

import { createMutation, createQuery } from "@tanstack/solid-query";
import { action } from "./api.ts";
import { affectedByChange } from "./invalidate.ts";
import { live, queryClient, reportError } from "./live.ts";
import { applyOptimistic } from "./optimistic.ts";

/**
 * Reads an action's result. Re-runs when `input` changes or a live event affects it, and every
 * `pollMs` while that returns a number (for things that change without an event).
 */
export function useAction<T>(
  name: string,
  input: () => unknown = () => ({}),
  enabled: () => boolean = () => true,
  pollMs: (data: T | undefined) => number | false = () => false,
) {
  return createQuery(() => ({
    queryKey: [name, input()],
    queryFn: () => action<T>(name, input()),
    enabled: enabled(),
    refetchInterval: (q: { state: { data?: T } }) => pollMs(q.state.data),
  }));
}

/**
 * What the inbox is asked for. The sidebar's count and the Inbox view ask the same way, so they
 * share one cached read instead of two.
 */
export function inboxInput(view: "live" | "snoozed" | "done", lane?: "signal" | "noise") {
  return { view, lane: view === "live" ? lane : undefined, limit: 100 };
}

/**
 * After a change: refresh the reads it can affect. Its live event refreshes them too; both land in
 * one refresh. Without the live feed nothing else will, so everything is read again.
 */
function changed(name: string) {
  live.refresh(live.connected() ? affectedByChange(name) : null);
}

/** Runs an action that changes something; failures and approvals show as toasts. */
export function useMutate<I, T = unknown>(name: string, onDone?: (result: T, input: I) => void) {
  return createMutation(() => ({
    mutationFn: (input: I) => action<T>(name, input),
    onSuccess: (result: T, input: I) => {
      changed(name);
      onDone?.(result, input);
    },
    onError: reportError,
  }));
}

/**
 * One-off action call with error reporting. Returns null when it didn't go through. Changes with
 * an instant version (done, snooze, read, archive, star) show before the server answers, and are
 * put back if it says no.
 */
export async function act<T>(name: string, input: unknown = {}): Promise<T | null> {
  const undo = applyOptimistic(queryClient, name, input);
  try {
    const r = await action<T>(name, input);
    changed(name);
    return r;
  } catch (err) {
    undo?.();
    reportError(err);
    return null;
  }
}
