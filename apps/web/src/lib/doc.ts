// A note open on this screen: a Loro copy kept in the browser (so it opens and takes edits offline),
// synced with Hearth through doc.sync a moment after you type, and whenever it changes elsewhere.
// Every edit is written to IndexedDB before it's sent anywhere (D59), so a closed tab, a crash or a
// hung connection loses nothing: the next open sends it. Other tabs with the note open get each
// edit at once over a BroadcastChannel.

import { LoroDoc, VersionVector } from "loro-crdt";
import { ApiError, action } from "./api.ts";
import {
  appendUpdate,
  keepDoc,
  loadDoc,
  type PendingKey,
  type PendingUpdate,
  pendingUpdates,
  type SavedDoc,
} from "./docStore.ts";
import { backoff, onLiveEvent } from "./live.ts";
import { type Claim, claimPeer } from "./peer.ts";
import { isTransient } from "./wholeSave.ts";

const SYNC_AFTER_MS = 500;
/** Typing that never pauses still syncs this often. */
const MAX_WAIT_MS = 2_000;
/** A sync that hasn't answered by now is treated as lost, and tried again. */
const TIMEOUT_MS = 10_000;
/** What a closing page can still send (browsers allow 64 kB). */
const KEEPALIVE_MAX = 60_000;

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** A short random key (getRandomValues works on plain http too; randomUUID needs https). */
const randomKey = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** Where this screen's edits stand. */
export type DocStatus =
  /** Hearth is taking them. */
  | { kind: "ok" }
  /** Hearth is out of reach: they wait here, and go when it's back. */
  | { kind: "offline" }
  /** Hearth turned them down, for this reason. */
  | { kind: "refused"; message: string }
  /** The note was deleted; `unsent` if it held edits Hearth never got (kept here). */
  | { kind: "gone"; unsent: boolean };

export class LiveDoc {
  readonly id: string;
  readonly doc = new LoroDoc();
  /** Who last changed it from elsewhere ("jarvis", "owner"), for a moment after they did. */
  onRemote: (actor: string) => void = () => {};
  onStatus: (status: DocStatus) => void = () => {};
  private server: string | null = null;
  /** This copy's own key for the edits it writes ahead, and how many it has written. */
  private readonly tab = randomKey();
  private n = 0;
  /** This copy's edits up to here are in the saved copy, and dropped. */
  private kept = 0;
  /** Other copies' written-ahead edits taken in here, to drop once the saved copy holds them. */
  private adopted: PendingKey[] = [];
  /** Writes ahead, in order, and how many haven't finished. */
  private writes: Promise<unknown> = Promise.resolve();
  private writing = 0;
  /** An edit couldn't be written ahead (no IndexedDB here): unsent edits exist only in this page. */
  private diskless = false;
  private claim: Claim | null = null;
  private channel: BroadcastChannel | null = null;
  private timer: number | undefined;
  private firstAt: number | undefined;
  private retry: number | undefined;
  private attempt = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private gone = false;
  private closed = false;
  private stops: (() => void)[] = [];

  constructor(id: string) {
    this.id = id;
    this.doc.setRecordTimestamp(true);
  }

  get text(): string {
    return this.doc.getText("body").toString();
  }

  /** Opens from this browser's copy if there is one, else waits for Hearth's. */
  async open(): Promise<void> {
    this.claim = await claimPeer(this.id);
    if (this.closed) {
      // Closed while it was opening (the note was closed again at once).
      this.claim?.release();
      throw new Error("closed");
    }
    const [saved, pending] = await Promise.all([loadDoc(this.id), pendingUpdates(this.id)]);
    if (saved) {
      this.doc.import(saved.snapshot);
      this.server = saved.server || null;
    }
    if (pending.length) {
      // Edits a closed or crashed tab never sent, and other open tabs' latest.
      this.doc.importBatch(pending.map((p) => p.data));
      this.adopted.push(...pending.map((p): PendingKey => [p.doc, p.tab, p.n]));
    }
    // This device's own peer: it holds all of that peer's edits now (see peer.ts).
    if (this.claim) this.doc.setPeerId(this.claim.peer);
    if (!saved) {
      await this.sync();
      if (this.server === null) {
        await this.close();
        throw new Error("This note isn't available offline yet.");
      }
    } else void this.sync();
    if (!this.closed) this.listen();
  }

  private listen() {
    this.stops.push(this.doc.subscribeLocalUpdates((data) => this.local(data)));
    this.stops.push(
      onLiveEvent((e) => {
        if (e.entityId !== this.id || e.kind !== "entity.updated") return;
        if (e.actor !== "owner") this.onRemote(e.actor);
        this.schedule(0);
      }),
    );
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(`hearth-doc:${this.id}`);
      channel.onmessage = (e: MessageEvent<PendingUpdate>) => this.heard(e.data);
      this.channel = channel;
    }
    const on = <K extends keyof WindowEventMap>(kind: K, fn: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(kind, fn);
      this.stops.push(() => window.removeEventListener(kind, fn));
    };
    on("online", () => this.schedule(0));
    on("pagehide", () => this.flush());
    on("beforeunload", (e) => {
      // Not yet written ahead, or never can be here: leaving now could lose it.
      if (this.writing === 0 && !(this.diskless && this.unsent())) return;
      e.preventDefault();
      e.returnValue = "";
    });
    const hidden = () => document.visibilityState === "hidden" && this.flush();
    document.addEventListener("visibilitychange", hidden);
    this.stops.push(() => document.removeEventListener("visibilitychange", hidden));
    // A safety net for an event missed while offline.
    const tick = window.setInterval(() => this.schedule(0), 30_000);
    this.stops.push(() => window.clearInterval(tick));
  }

  /** An edit made here: written ahead, passed to other tabs, then synced shortly. */
  private local(data: Uint8Array) {
    if (this.gone) return;
    const entry: PendingUpdate = { doc: this.id, tab: this.tab, n: ++this.n, data };
    this.writing++;
    this.writes = this.writes
      .then(() => appendUpdate(entry))
      .then((written) => {
        if (!written) {
          // Not on disk, but maybe sent: this peer could reopen without it, so it's retired.
          this.diskless = true;
          this.claim?.retire();
        }
        this.channel?.postMessage(entry);
      })
      .finally(() => {
        this.writing--;
      });
    const now = Date.now();
    this.firstAt ??= now;
    this.schedule(Math.max(0, Math.min(SYNC_AFTER_MS, this.firstAt + MAX_WAIT_MS - now)));
  }

  /** Another tab's edit to this note. */
  private heard(u: PendingUpdate | undefined) {
    if (!u || u.doc !== this.id || this.gone) return;
    this.doc.import(u.data);
    this.adopted.push([u.doc, u.tab, u.n]);
  }

  schedule(ms: number) {
    if (this.gone || this.closed) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.firstAt = undefined;
      void this.sync();
    }, ms);
  }

  /** Waits until every edit made so far is written ahead. */
  private async written() {
    let w: Promise<unknown>;
    do {
      w = this.writes;
      await w;
    } while (w !== this.writes);
  }

  /** Sends what's new here and takes in what's new there. One at a time. */
  async sync(): Promise<void> {
    if (this.gone) return;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    window.clearTimeout(this.retry);
    this.running = (async () => {
      do {
        this.again = false;
        // Nothing goes to Hearth before it's on disk here.
        await this.written();
        const from = this.server ? VersionVector.decode(unb64(this.server)) : null;
        const update = from && this.hasNew(from) ? this.doc.export({ mode: "update", from }) : null;
        try {
          const r = await action<{ update: string; version: string }>(
            "doc.sync",
            {
              id: this.id,
              ...(this.server ? { version: b64(this.doc.oplogVersion().encode()) } : {}),
              ...(update ? { update: b64(update) } : {}),
            },
            { timeoutMs: TIMEOUT_MS },
          );
          this.doc.import(unb64(r.update));
          this.server = r.version;
          this.attempt = 0;
          this.onStatus({ kind: "ok" });
          await this.keep();
        } catch (err) {
          if (err instanceof ApiError && err.code === "not_found") return this.lost();
          if (isTransient(err)) {
            this.onStatus({ kind: "offline" });
            if (!this.closed)
              this.retry = window.setTimeout(() => void this.sync(), backoff(this.attempt++));
          } else {
            this.onStatus({ kind: "refused", message: (err as Error).message });
          }
          return;
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** A closing page: sends what's unsent in one request that outlives it, if it's small enough. */
  private flush() {
    // Only what's written ahead may go (see peer.ts); the rest goes from disk next time.
    if (this.gone || this.writing > 0 || !this.server) return;
    const from = VersionVector.decode(unb64(this.server));
    if (!this.hasNew(from)) return;
    const update = b64(this.doc.export({ mode: "update", from }));
    if (update.length > KEEPALIVE_MAX) return;
    const version = b64(this.doc.oplogVersion().encode());
    void action("doc.sync", { id: this.id, version, update }, { keepalive: true }).catch(() => {});
  }

  /** Saves this copy and drops the written-ahead edits it now holds. */
  private async keep(): Promise<void> {
    await this.written();
    const cut = this.n;
    const adopted = this.adopted.length;
    const drop = this.adopted.slice(0, adopted);
    for (let n = this.kept + 1; n <= cut; n++) drop.push([this.id, this.tab, n]);
    const ok = await keepDoc(this.id, (saved) => this.copy(saved), drop);
    if (!ok) return;
    this.kept = cut;
    this.adopted.splice(0, adopted);
  }

  /** The copy to save: this one, holding everything the saved one holds (another tab's, say). */
  private copy(saved: SavedDoc | null): SavedDoc {
    if (saved && !this.holds(saved)) this.doc.import(saved.snapshot);
    return {
      id: this.id,
      snapshot: this.doc.export({ mode: "snapshot" }),
      server: this.server ?? "",
      version: this.doc.oplogVersion().encode(),
      ...(this.unsent() ? { unsent: 1 as const } : {}),
    };
  }

  private holds(saved: SavedDoc): boolean {
    if (!saved.version) return false;
    const c = this.doc.oplogVersion().compare(VersionVector.decode(saved.version));
    return c === 0 || c === 1;
  }

  /** Deleted (or never a doc). What never reached Hearth stays here, in case it's put back. */
  private async lost() {
    this.gone = true;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.retry);
    const unsent = this.unsent();
    await this.written();
    const drop = [...this.adopted];
    for (let n = this.kept + 1; n <= this.n; n++) drop.push([this.id, this.tab, n]);
    await keepDoc(
      this.id,
      // Another tab's copy with edits this one hasn't seen stays too.
      (saved) => (unsent ? this.copy(saved) : saved?.unsent && !this.holds(saved) ? saved : null),
      drop,
    );
    this.onStatus({ kind: "gone", unsent });
  }

  /** Whether this copy holds edits Hearth doesn't have. */
  private unsent(): boolean {
    if (!this.server) return (this.doc.oplogVersion().toJSON() as Map<string, number>).size > 0;
    return this.hasNew(VersionVector.decode(unb64(this.server)));
  }

  /** Has this copy got changes the server's version doesn't? */
  private hasNew(server: VersionVector): boolean {
    const mine = this.doc.oplogVersion().toJSON() as Map<string, number>;
    const theirs = server.toJSON() as Map<string, number>;
    for (const [peer, n] of mine) if ((theirs.get(peer) ?? 0) < n) return true;
    return false;
  }

  /** Sends what's left, saves this copy, and lets another copy have its peer. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.retry);
    for (const stop of this.stops) stop();
    this.stops = [];
    try {
      if (this.server !== null && !this.gone) await this.sync();
      await this.written();
      if (this.server !== null && !this.gone && (this.n > this.kept || this.adopted.length))
        await this.keep();
    } finally {
      this.channel?.close();
      this.channel = null;
      this.claim?.release();
    }
  }
}

/** Sends edits this device kept for notes that aren't open: a tab closed before they went. */
export async function sendUnsent(ids: string[]): Promise<void> {
  for (const id of ids) {
    const doc = new LiveDoc(id);
    try {
      await doc.open();
    } catch {
      continue;
    }
    await doc.close();
  }
}
