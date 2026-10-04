// What this browser keeps in IndexedDB so nothing typed is lost (D38, D59): each note's last
// synced copy, the edits made since that Hearth hasn't confirmed yet, and the unsaved copy of a
// board or spreadsheet. Kept apart from doc.ts so signing out can check and clear it without
// loading Loro, which only the doc editor needs.

const DB = "hearth-docs";
const DOCS = "docs";
/** A note's edits not yet confirmed by Hearth, written before they're sent. */
const UPDATES = "updates";
/** Boards and spreadsheets with changes Hearth hasn't saved. */
const UNSAVED = "unsaved";

export interface SavedDoc {
  id: string;
  snapshot: Uint8Array;
  /** The server's version at the last sync. */
  server: string;
}

export interface PendingUpdate {
  doc: string;
  /** The tab that made it. */
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
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(UPDATES))
          db.createObjectStore(UPDATES, { keyPath: ["doc", "tab", "n"] });
        if (!db.objectStoreNames.contains(UNSAVED))
          db.createObjectStore(UNSAVED, { keyPath: "key" });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Let signing out (or a newer tab) delete or upgrade it.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
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

/** Runs one request in its own transaction; null when IndexedDB isn't there. */
async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve((req?.result as T | undefined) ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Every key of a doc's pending edits sorts between these. */
const ofDoc = (doc: string) => IDBKeyRange.bound([doc], [doc, []]);

export const loadDoc = (id: string) =>
  run<SavedDoc | undefined>(DOCS, "readonly", (s) => s.get(id)).then((r) => r ?? null);

export async function saveDoc(rec: SavedDoc): Promise<void> {
  await run(DOCS, "readwrite", (s) => s.put(rec));
}

export async function forgetDoc(id: string): Promise<void> {
  await run(DOCS, "readwrite", (s) => s.delete(id));
}

/** Writes an edit ahead of sending it. Resolves once it's on disk. */
export async function appendUpdate(u: PendingUpdate): Promise<void> {
  await run(UPDATES, "readwrite", (s) => s.put(u));
}

/** A doc's edits that Hearth hasn't confirmed, from every tab, oldest first per tab. */
export const pendingUpdates = (doc: string) =>
  run<PendingUpdate[]>(UPDATES, "readonly", (s) => s.getAll(ofDoc(doc))).then((r) => r ?? []);

/** Drops edits Hearth has confirmed. */
export async function dropUpdates(keys: [string, string, number][]): Promise<void> {
  if (!keys.length) return;
  const db = await idb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(UPDATES, "readwrite");
      for (const k of keys) tx.objectStore(UPDATES).delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export const loadUnsaved = <T>(key: string) =>
  run<Unsaved<T> | undefined>(UNSAVED, "readonly", (s) => s.get(key)).then((r) => r ?? null);

export async function saveUnsaved<T>(rec: Unsaved<T>): Promise<void> {
  await run(UNSAVED, "readwrite", (s) => s.put(rec));
}

export async function dropUnsaved(key: string): Promise<void> {
  await run(UNSAVED, "readwrite", (s) => s.delete(key));
}

/** Whether anything typed here hasn't reached Hearth yet (checked before signing out). */
export async function hasUnsynced(): Promise<boolean> {
  const counts = await Promise.all(
    [UPDATES, UNSAVED].map((store) => run<number>(store, "readonly", (s) => s.count())),
  );
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

/** Drops this browser's copies of every doc (on sign-out). */
export function forgetAllDocs() {
  try {
    indexedDB.deleteDatabase(DB);
  } catch {}
}
