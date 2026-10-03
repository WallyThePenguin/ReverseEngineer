// A doc open on this screen: a Loro copy kept in the browser (so it opens and takes edits offline),
// synced with Hearth through doc.sync whenever you type or something changes it elsewhere.

import { LoroDoc, VersionVector } from "loro-crdt";
import { action } from "./api.ts";
import { onLiveEvent } from "./live.ts";

const DB = "hearth-docs";
const STORE = "docs";

interface Saved {
  id: string;
  snapshot: Uint8Array;
  /** The server's version at the last sync. */
  server: string;
}

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function load(id: string): Promise<Saved | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as Saved | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function save(rec: Saved): Promise<void> {
  const db = await idb();
  db?.transaction(STORE, "readwrite").objectStore(STORE).put(rec);
}

export class LiveDoc {
  readonly id: string;
  readonly doc = new LoroDoc();
  /** Who last changed it from elsewhere ("jarvis", "owner"), for a moment after they did. */
  onRemote: (actor: string) => void = () => {};
  /** Whether everything typed here has reached Hearth. */
  onSaved: (saved: boolean) => void = () => {};
  private server: string | null = null;
  private timer: number | undefined;
  private running: Promise<void> | null = null;
  private again = false;
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
    const saved = await load(this.id);
    if (saved) {
      this.doc.import(saved.snapshot);
      this.server = saved.server;
      void this.sync();
    } else {
      await this.sync();
      if (this.server === null) throw new Error("This note isn't available offline yet.");
    }
    this.stops.push(this.doc.subscribeLocalUpdates(() => this.schedule(500)));
    this.stops.push(
      onLiveEvent((e) => {
        if (e.entityId !== this.id || e.kind !== "entity.updated") return;
        if (e.actor !== "owner") this.onRemote(e.actor);
        this.schedule(0);
      }),
    );
    const online = () => this.schedule(0);
    window.addEventListener("online", online);
    this.stops.push(() => window.removeEventListener("online", online));
    // A safety net for an event missed while offline.
    const tick = window.setInterval(() => this.schedule(0), 30_000);
    this.stops.push(() => window.clearInterval(tick));
  }

  schedule(ms: number) {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.sync(), ms);
  }

  /** Sends what's new here and takes in what's new there. One at a time. */
  async sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const from = this.server ? VersionVector.decode(unb64(this.server)) : null;
        const update = from ? this.doc.export({ mode: "update", from }) : null;
        const sending = update !== null && update.length > 0 && this.hasNew(from!);
        try {
          const r = await action<{ update: string; version: string }>("doc.sync", {
            id: this.id,
            ...(this.server ? { version: b64(this.doc.oplogVersion().encode()) } : {}),
            ...(sending ? { update: b64(update!) } : {}),
          });
          this.doc.import(unb64(r.update));
          this.server = r.version;
          await save({
            id: this.id,
            snapshot: this.doc.export({ mode: "snapshot" }),
            server: r.version,
          });
          this.onSaved(!this.hasNew(VersionVector.decode(unb64(r.version))));
        } catch {
          // Offline or Hearth is restarting: the edits wait here and go with the next sync.
          this.onSaved(false);
          await save({
            id: this.id,
            snapshot: this.doc.export({ mode: "snapshot" }),
            server: this.server ?? "",
          }).catch(() => {});
          return;
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Has this copy got changes the server's version doesn't? */
  private hasNew(server: VersionVector): boolean {
    const mine = this.doc.oplogVersion().toJSON() as Map<string, number>;
    const theirs = server.toJSON() as Map<string, number>;
    for (const [peer, n] of mine) if ((theirs.get(peer) ?? 0) < n) return true;
    return false;
  }

  close() {
    window.clearTimeout(this.timer);
    void this.sync();
    for (const stop of this.stops) stop();
  }
}
