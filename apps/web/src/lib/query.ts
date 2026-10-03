// Reading and writing through actions, cached and refreshed by live events.

import { createMutation, createQuery } from "@tanstack/solid-query";
import { action } from "./api.ts";
import { queryClient, reportError } from "./live.ts";

/**
 * Reads an action's result. Re-runs when `input` changes or a live event arrives, and every
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

/** Runs an action that changes something; failures and approvals show as toasts. */
export function useMutate<I, T = unknown>(name: string, onDone?: (result: T, input: I) => void) {
  return createMutation(() => ({
    mutationFn: (input: I) => action<T>(name, input),
    onSuccess: (result: T, input: I) => {
      void queryClient.invalidateQueries();
      onDone?.(result, input);
    },
    onError: reportError,
  }));
}

/** One-off action call with error reporting. Returns null when it didn't go through. */
export async function act<T>(name: string, input: unknown = {}): Promise<T | null> {
  try {
    const r = await action<T>(name, input);
    void queryClient.invalidateQueries();
    return r;
  } catch (err) {
    reportError(err);
    return null;
  }
}
