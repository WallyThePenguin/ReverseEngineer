// This browser's copies of docs, kept in IndexedDB so a note opens and takes edits offline. Kept
// apart from doc.ts so signing out can clear them without loading Loro, which only the doc
// editor needs.

const DB = "hearth-docs";
const STORE = "docs";

export interface SavedDoc {
  id: string;
  snapshot: Uint8Array;
  /** The server's version at the last sync. */
  server: string;
}

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

export async function loadDoc(id: string): Promise<SavedDoc | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => resolve((req.result as SavedDoc | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function saveDoc(rec: SavedDoc): Promise<void> {
  const db = await idb();
  db?.transaction(STORE, "readwrite").objectStore(STORE).put(rec);
}

export async function forgetDoc(id: string): Promise<void> {
  const db = await idb();
  db?.transaction(STORE, "readwrite").objectStore(STORE).delete(id);
}

/** Drops this browser's copies of every doc (on sign-out). */
export function forgetAllDocs() {
  try {
    indexedDB.deleteDatabase(DB);
  } catch {}
}
