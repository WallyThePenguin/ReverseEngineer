// The live connection: every committed event refreshes the screens it affects, Jarvis's reply
// text streams in as it's written, and a dropped connection comes back by itself.

import { QueryClient } from "@tanstack/solid-query";
import { createRoot, createSignal } from "solid-js";
import { getMe, signedOut } from "./api.ts";
import { affectedBy, type Rule, touches, union } from "./invalidate.ts";

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

/** Changes close together are read back in one go, this long after the first. */
const REFRESH_MS = 120;
/** The server says something at least every 20 s; this much silence means the line is dead. */
const SILENCE_MS = 45_000;
/** How long the feed may be down before the screen says so. */
const BANNER_MS = 3_000;
const MAX_BACKOFF_MS = 30_000;

/** Waits between tries: 1 s doubling to 30 s, each somewhere in its upper half. */
export function backoff(attempt: number, random = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

function createLive() {
  const [connected, setConnected] = createSignal(false);
  const [reconnecting, setReconnecting] = createSignal(false);
  /** Reply text that's streaming, by turn id. Cleared when the stored message lands. */
  const [streams, setStreams] = createSignal<
    Record<string, { conversationId: string; text: string }>
  >({});
  let source: EventSource | null = null;
  let running = false;
  /** The newest event seen, so a new connection picks up right after it. */
  let lastSeq = 0;
  let everConnected = false;
  let attempt = 0;
  let heardAt = 0;
  let retry: number | undefined;
  let watchdog: number | undefined;
  let banner: number | undefined;
  let pending: Rule | null | undefined;
  let flushAt: number | undefined;

  /** Reads again the cached reads a rule covers (null: all of them). */
  const flush = () => {
    const rule = pending;
    pending = undefined;
    flushAt = undefined;
    if (rule === undefined) return;
    const predicate = (q: { queryKey: readonly unknown[] }) =>
      rule === null || touches(rule, q.queryKey);
    // A read already on its way may have left before the change; read it again once it lands.
    for (const q of queryClient.getQueryCache().findAll({ predicate, type: "active" })) {
      if (q.state.fetchStatus !== "fetching") continue;
      const again = () =>
        void queryClient.invalidateQueries(
          { queryKey: q.queryKey, exact: true },
          { cancelRefetch: false },
        );
      q.promise?.then(again, again);
    }
    void queryClient.invalidateQueries({ predicate }, { cancelRefetch: false });
  };

  const refresh = (rule: Rule | null) => {
    pending = pending === undefined ? rule : union([pending, rule]);
    if (flushAt === undefined) flushAt = window.setTimeout(flush, REFRESH_MS);
  };

  const heard = () => {
    heardAt = Date.now();
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      // No word from Hearth for too long: the connection is dead even if it looks open.
      if (running) down(true);
    }, SILENCE_MS);
  };

  const down = (retryNow: boolean) => {
    setConnected(false);
    if (banner === undefined && !reconnecting())
      banner = window.setTimeout(() => setReconnecting(true), BANNER_MS);
    if (retryNow) schedule();
  };

  const schedule = () => {
    if (!running || retry !== undefined) return;
    source?.close();
    source = null;
    window.clearTimeout(watchdog);
    retry = window.setTimeout(() => {
      retry = undefined;
      void reconnect();
    }, backoff(attempt++));
  };

  /** Checks the session first: a feed refused because you're signed out means sign in again. */
  const reconnect = async () => {
    const me = await getMe().catch(() => null);
    if (!running) return;
    if (me && !me.signedIn) return signedOut();
    if (!me) return schedule();
    open();
  };

  const open = () => {
    const url = lastSeq > 0 ? `/api/events?after=${lastSeq}` : "/api/events";
    const s = new EventSource(url, { withCredentials: true });
    source = s;
    s.addEventListener("ready", (msg) => {
      if (s !== source) return;
      const after = Number(
        (JSON.parse((msg as MessageEvent<string>).data) as { after?: number }).after,
      );
      if (Number.isFinite(after) && after > lastSeq) lastSeq = after;
      attempt = 0;
      window.clearTimeout(banner);
      banner = undefined;
      setReconnecting(false);
      setConnected(true);
      heard();
      // The first connection comes with each screen's own first read. After a gap, events
      // missed are replayed, but things that change without one (a snooze running out) aren't.
      if (everConnected) {
        setStreams({});
        refresh(null);
      }
      everConnected = true;
    });
    s.addEventListener("ping", () => {
      if (s === source) heard();
    });
    s.addEventListener("error", () => {
      if (s !== source) return;
      // The browser tries a dropped connection again by itself. An error reply (a 502 while
      // Hearth restarts, a 401 once signed out) ends the feed for good, so try again here.
      down(s.readyState === EventSource.CLOSED);
    });
    s.addEventListener("event", (msg) => {
      if (s !== source) return;
      heard();
      let e: LiveEvent;
      try {
        e = JSON.parse((msg as MessageEvent<string>).data) as LiveEvent;
      } catch {
        return;
      }
      if (e.seq > lastSeq) lastSeq = e.seq;
      if (e.kind === "conversation.appended" && e.payload.kind === "assistant_message") {
        const turnId = String(e.payload.turnId ?? "");
        setStreams((st) => {
          const { [turnId]: _done, ...rest } = st;
          return rest;
        });
      }
      for (const l of listeners) l(e);
      refresh(affectedBy(e));
    });
    s.addEventListener("stream", (msg) => {
      if (s !== source) return;
      heard();
      const { conversationId, turnId, delta } = JSON.parse((msg as MessageEvent<string>).data) as {
        conversationId: string;
        turnId: string;
        delta: string;
      };
      setStreams((st) => ({
        ...st,
        [turnId]: { conversationId, text: (st[turnId]?.text ?? "") + delta },
      }));
    });
  };

  /** Back online or back on screen: if the feed isn't plainly alive, try now, not later. */
  const wake = () => {
    if (!running || document.visibilityState === "hidden") return;
    const alive = source?.readyState === EventSource.OPEN && Date.now() - heardAt < SILENCE_MS;
    if (alive) return;
    attempt = 0;
    window.clearTimeout(retry);
    retry = undefined;
    source?.close();
    source = null;
    void reconnect();
  };
  // (Unit tests load this outside a browser.)
  if (typeof window !== "undefined") {
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
  }

  return {
    connected,
    /** True once the feed has been down a few seconds; the shell shows a banner. */
    reconnecting,
    streams,
    /** Reads again what a change affects (null: everything), together with other changes. */
    refresh,
    start() {
      if (running) return;
      running = true;
      open();
    },
    stop() {
      running = false;
      source?.close();
      source = null;
      for (const t of [retry, watchdog, banner]) window.clearTimeout(t);
      retry = watchdog = banner = undefined;
      lastSeq = 0;
      attempt = 0;
      everConnected = false;
      setConnected(false);
      setReconnecting(false);
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
