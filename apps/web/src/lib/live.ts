// The live connection: every committed event refreshes what's on screen, and Jarvis's reply
// text streams in as it's written.

import { QueryClient } from "@tanstack/solid-query";
import { createRoot, createSignal } from "solid-js";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } },
});

export interface LiveEvent {
  seq: number;
  kind: string;
  entityId: string | null;
  actor: string;
  payload: Record<string, unknown>;
}

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();

/** Runs `fn` for every live event while the calling component is mounted. */
export function onLiveEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function createLive() {
  const [connected, setConnected] = createSignal(false);
  /** Reply text that's streaming, by turn id. Cleared when the stored message lands. */
  const [streams, setStreams] = createSignal<
    Record<string, { conversationId: string; text: string }>
  >({});
  let source: EventSource | null = null;
  let refresh: number | undefined;

  const scheduleRefresh = () => {
    window.clearTimeout(refresh);
    refresh = window.setTimeout(() => void queryClient.invalidateQueries(), 120);
  };

  return {
    connected,
    streams,
    start() {
      if (source) return;
      source = new EventSource("/api/events", { withCredentials: true });
      source.addEventListener("ready", () => {
        setConnected(true);
        scheduleRefresh();
      });
      source.addEventListener("error", () => setConnected(false));
      source.addEventListener("event", (msg) => {
        const e = JSON.parse((msg as MessageEvent<string>).data) as LiveEvent;
        if (e.kind === "conversation.appended" && e.payload.kind === "assistant_message") {
          const turnId = String(e.payload.turnId ?? "");
          setStreams((s) => {
            const { [turnId]: _done, ...rest } = s;
            return rest;
          });
        }
        for (const l of listeners) l(e);
        scheduleRefresh();
      });
      source.addEventListener("stream", (msg) => {
        const { conversationId, turnId, delta } = JSON.parse(
          (msg as MessageEvent<string>).data,
        ) as {
          conversationId: string;
          turnId: string;
          delta: string;
        };
        setStreams((s) => ({
          ...s,
          [turnId]: { conversationId, text: (s[turnId]?.text ?? "") + delta },
        }));
      });
    },
    stop() {
      source?.close();
      source = null;
      setConnected(false);
    },
  };
}

export const live = createRoot(createLive);

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

function createToasts() {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let next = 1;
  return {
    toasts,
    show(text: string, tone: Toast["tone"] = "info") {
      const id = next++;
      setToasts((t) => [...t, { id, text, tone }]);
      window.setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== id)),
        tone === "error" ? 6000 : 3500,
      );
    },
  };
}

export const toast = createRoot(createToasts);

/** Shows what happened to an action that didn't simply succeed. */
export function reportError(err: unknown) {
  const e = err as { code?: string; message?: string };
  if (e.code === "pending_approval") toast.show(`Waiting for your approval: ${e.message}`);
  else toast.show(e.message ?? String(err), "error");
}
