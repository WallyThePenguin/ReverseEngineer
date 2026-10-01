// One LISTEN connection for the whole server, fanned out to every open screen.
import { listenChannels } from "@hearth/kernel";
import type pg from "pg";

export const STREAM_CHANNEL = "hearth_stream";

export interface HubListener {
  /** New events were committed, up to this seq. */
  onEvents(seq: number): void;
  /** Jarvis is typing: a chunk of reply text that isn't stored yet. */
  onStream(payload: string): void;
}

export class EventHub {
  private readonly listeners = new Set<HubListener>();
  private stopListening: (() => Promise<void>) | null = null;
  private readonly pool: pg.Pool | null;

  constructor(pool: pg.Pool | null) {
    this.pool = pool;
  }

  start(): void {
    if (!this.pool || this.stopListening) return;
    this.stopListening = listenChannels(this.pool, ["hearth_event", STREAM_CHANNEL], (ch, p) => {
      if (ch === STREAM_CHANNEL) for (const l of this.listeners) l.onStream(p);
      else this.publish(Number(p));
    });
  }

  /** Wakes every listener; also used by tests that don't have a LISTEN connection. */
  publish(seq: number): void {
    for (const l of this.listeners) l.onEvents(seq);
  }

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }

  async stop(): Promise<void> {
    await this.stopListening?.();
    this.stopListening = null;
    this.listeners.clear();
  }
}
