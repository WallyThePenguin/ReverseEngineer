// What this browser keeps in IndexedDB so nothing typed is lost (D38, D59): each note's saved copy,
// the edits made since that it doesn't hold yet (written before they're sent anywhere), the peer
// ids this device edits notes as, and the unsaved copy of a board or spreadsheet. Kept apart from
// doc.ts so signing out can check and clear it without loading Loro, which only notes need.

const DB = "hearth-docs";
const DOCS = "docs";
/** A note's edits that its saved copy doesn't hold yet, written before they're sent. */
const UPDATES = "updates";
/** Boards and spreadsheets with changes Hearth hasn't saved. */
const UNSAVED = "unsaved";
/** The Loro peer ids this device edits notes as, one per slot (see peer.ts). */
const PEERS = "peers";
/** Saved copies holding edits Hearth doesn't have yet. */
const UNSENT = "unsent";

export interface SavedDoc {
  id: string;
  snapshot: Uint8Array;
  /** The server's version at the last sync ("" before the first). */
  server: string;
  /** What the snapshot holds (an encoded version vector); missing on copies saved before D59. */
  version?: Uint8Array;
  /** 1 when the snapshot holds edits Hearth doesn't have yet. */
  unsent?: 1;
}

export type PendingKey = [doc: string, tab: string, n: number];

export interface PendingUpdate {
  doc: string;
  /** The open copy that made it. */
  tab: string;
  n: number;
  data: Uint8Array;
}

export interface Unsaved<T> {
  /** "canvas:<id>" or "sheet:<id>". */
  key: string;
  data: T;
  /** The saved version the changes were made on, and what it held. */
  baseVersion: number;
  base: T | null;
  title?: string;
}

let opening: Promise<IDBDatabase | null> | null = null;

function idb(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        const docs = db.objectStoreNames.contains(DOCS)
          ? req.transaction!.objectStore(DOCS)
          : db.createObjectStore(DOCS, { keyPath: "id" });
        if (!docs.indexNames.contains(UNSENT)) docs.createIndex(UNSENT, UNSENT);
        if (!db.objectStoreNames.contains(UPDATES))
          db.createObjectStore(UPDATES, { keyPath: ["doc", "tab", "n"] });
        if (!db.objectStoreNames.contains(UNSAVED))
          db.createObjectStore(UNSAVED, { keyPath: "key" });
        if (!db.objectStoreNames.contains(PEERS)) db.createObjectStore(PEERS, { keyPath: "slot" });
      };
      // A tab still running an older Hearth holds the old version open, so the upgrade waits for
      // it to close. Until then, carry on without IndexedDB rather than wait (edits then go
      // straight to Hearth, as before D59).
      req.onblocked = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        // Let signing out (or a newer tab) delete or upgrade it.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        opening = Promise.resolve(db);
        resolve(db);
      };
      req.onerror = () => {
        opening = null;
        resolve(null);
      };
    } catch {
      opening = null;
      resolve(null);
    }
  });
  return opening;
}

/**
 * Runs `fn` in one transaction over `stores`. Resolves true once it's committed, false if it
 * failed or IndexedDB isn't there. `fn` may only do IndexedDB work and synchronous work.
 */
async function within(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => void,
): Promise<boolean> {
  const db = await idb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(stores, mode);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
      fn(tx);
    } catch {
      resolve(false);
    }
  });
}

/** Runs one request; its result, or null when it failed or IndexedDB isn't there. */
async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  let req: IDBRequest<T> | undefined;
  const ok = await within([store], mode, (tx) => {
    req = fn(tx.objectStore(store));
  });
  return ok ? ((req?.result as T | undefined) ?? null) : null;
}

/** Every key of a doc's pending edits sorts between these. */
const ofDoc = (doc: string) => IDBKeyRange.bound([doc], [doc, []]);

export const loadDoc = (id: string) =>
  run<SavedDoc | undefined>(DOCS, "readonly", (s) => s.get(id));

/**
 * Replaces a note's saved copy and drops the edits it now holds, in one go. `next` gets the copy
 * saved now (another tab's, maybe) and must return one holding everything that one holds, so the
 * saved copy only ever grows and an edit is never dropped before a saved copy has it; or null to
 * delete it (the note was deleted, and Hearth has everything in it).
 */
export function keepDoc(
  id: string,
  next: (saved: SavedDoc | null) => SavedDoc | null,
  drop: PendingKey[],
): Promise<boolean> {
  return within([DOCS, UPDATES], "readwrite", (tx) => {
    const docs = tx.objectStore(DOCS);
    const req = docs.get(id);
    req.onsuccess = () => {
      try {
        const rec = next((req.result as SavedDoc | undefined) ?? null);
        if (rec) docs.put(rec);
        else docs.delete(id);
        for (const k of drop) tx.objectStore(UPDATES).delete(k);
      } catch {
        tx.abort();
      }
    };
  });
}

/** Notes with edits Hearth may not have: written ahead, or held by a saved copy. */
export async function unsentDocs(): Promise<string[]> {
  const [keys, docs] = await Promise.all([
    run<IDBValidKey[]>(UPDATES, "readonly", (s) => s.getAllKeys()),
    run<IDBValidKey[]>(DOCS, "readonly", (s) => s.index(UNSENT).getAllKeys()),
  ]);
  const ids = [...(keys ?? []).map((k) => (k as PendingKey)[0]), ...((docs ?? []) as string[])];
  return [...new Set(ids)];
}

/**
 * Sends what notes kept here that never reached Hearth (their tab closed first), once Hearth is
 * open again. Loads the doc code, and Loro with it, only if there's something to send.
 */
export async function sendKeptNotes(): Promise<void> {
  const ids = await unsentDocs().catch(() => []);
  if (!ids.length) return;
  const { sendUnsent } = await import("./doc.ts");
  await sendUnsent(ids);
}

/** Writes an edit ahead of sending it. True once it's on disk. */
export const appendUpdate = (u: PendingUpdate) =>
  within([UPDATES], "readwrite", (tx) => {
    tx.objectStore(UPDATES).put(u);
  });

/** A note's edits that its saved copy may not hold, from every tab. */
export const pendingUpdates = (doc: string) =>
  run<PendingUpdate[]>(UPDATES, "readonly", (s) => s.getAll(ofDoc(doc))).then((r) => r ?? []);

/** The peer id for one of this device's slots, made the first time; null without IndexedDB. */
export async function peerFor(slot: number): Promise<bigint | null> {
  let peer: string | null = null;
  const ok = await within([PEERS], "readwrite", (tx) => {
    const s = tx.objectStore(PEERS);
    const req = s.get(slot);
    req.onsuccess = () => {
      const kept = (req.result as { peer?: string } | undefined)?.peer;
      if (kept && /^\d{1,19}$/.test(kept)) {
        peer = kept;
        return;
      }
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      let n = 0n;
      for (const b of bytes) n = (n << 8n) | BigInt(b);
      peer = (n & 0x7fff_ffff_ffff_ffffn).toString();
      s.put({ slot, peer });
    };
  });
  return ok && peer !== null ? BigInt(peer) : null;
}

/** Gives a slot a new peer id next time: an edit made as this one may not have been written. */
export async function retirePeer(slot: number): Promise<void> {
  await run(PEERS, "readwrite", (s) => s.delete(slot));
}

export const loadUnsaved = <T>(key: string) =>
  run<Unsaved<T> | undefined>(UNSAVED, "readonly", (s) => s.get(key));

export async function saveUnsaved<T>(rec: Unsaved<T>): Promise<void> {
  await run(UNSAVED, "readwrite", (s) => s.put(rec));
}

export async function dropUnsaved(key: string): Promise<void> {
  await run(UNSAVED, "readwrite", (s) => s.delete(key));
}

/** Whether anything typed here hasn't reached Hearth yet (checked before signing out). */
export async function hasUnsynced(): Promise<boolean> {
  const counts = await Promise.all([
    run<number>(UPDATES, "readonly", (s) => s.count()),
    run<number>(UNSAVED, "readonly", (s) => s.count()),
    run<number>(DOCS, "readonly", (s) => s.index(UNSENT).count()),
  ]);
  return counts.some((n) => (n ?? 0) > 0);
}

/**
 * Asks before signing out would throw away edits that haven't reached Hearth. True to go ahead.
 */
export async function okToSignOut(): Promise<boolean> {
  if (!(await hasUnsynced().catch(() => false))) return true;
  return window.confirm(
    "Some of your edits haven't reached Hearth yet. Signing out now deletes them from this device. Sign out anyway?",
  );
}

/** Drops this browser's copies of every doc, and its peer ids (on sign-out). */
export function forgetAllDocs() {
  try {
    indexedDB.deleteDatabase(DB);
  } catch {}
}
