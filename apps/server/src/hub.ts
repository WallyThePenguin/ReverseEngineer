// One LISTEN connection for the whole server, fanned out to every open screen.
import { listenChannels } from "@hearth/kernel";
import type pg from "pg";

export const STREAM_CHANNEL = "hearth_stream";

export interface HubListener {
  /** New events were committed, up to this seq. */
  onEvents(seq: number): void;
  /** Jarvis is typing: a chunk of reply text that isn't stored yet. */
  onStream(payload: string): void;
  /** Hearth is stopping. */
  onStop?(): void;
}

export class EventHub {
  private readonly listeners = new Set<HubListener>();
  private stopListening: (() => Promise<void>) | null = null;
  private readonly pool: pg.Pool | null;
  private stopped = false;

  constructor(pool: pg.Pool | null) {
    this.pool = pool;
  }

  start(): void {
    const pool = this.pool;
    if (!pool || this.stopListening) return;
    this.stopListening = listenChannels(
      pool,
      ["hearth_event", STREAM_CHANNEL],
      (ch, p) => {
        if (ch === STREAM_CHANNEL) for (const l of this.listeners) l.onStream(p);
        else this.publish(Number(p));
      },
      {
        // Events committed while LISTEN was down were never announced: wake everyone up to the
        // newest, so open screens and phone notifications catch up now, not at the next event.
        // At the very start too, for anything committed before LISTEN was in place.
        onListening: () => void this.catchUp(pool),
      },
    );
  }

  private async catchUp(pool: pg.Pool): Promise<void> {
    try {
      const { rows } = await pool.query<{ seq: string | null }>(
        "SELECT max(seq) AS seq FROM event",
      );
      const seq = Number(rows[0]?.seq ?? 0);
      if (seq > 0 && !this.stopped) this.publish(seq);
    } catch (err) {
      console.warn(`[server] catching up after LISTEN: ${(err as Error).message}`);
    }
  }

  /** Wakes every listener; also used by tests that don't have a LISTEN connection. */
  publish(seq: number): void {
    for (const l of this.listeners) l.onEvents(seq);
  }

  subscribe(listener: HubListener): () => void {
    if (this.stopped) {
      queueMicrotask(() => listener.onStop?.());
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.stopListening?.();
    this.stopListening = null;
    for (const l of [...this.listeners]) l.onStop?.();
    this.listeners.clear();
  }
}
