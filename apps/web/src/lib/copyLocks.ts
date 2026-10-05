// Which kept copies of a board, a spreadsheet or meeting notes belong to screens still open (D59).
// Each screen keeps its own copy of what Hearth doesn't have yet (wholeSave.ts), and holds a Web
// Lock named after it from before it first keeps it until it closes; the browser lets a lock go
// with the tab that held it. Another screen takes over only copies whose lock is free, so not an
// open screen's: that one saves its own, and a card it removes afterwards stays removed. (A screen
// still running an older Hearth holds no lock, so its copy is taken over as before.)

import { type Unsaved, unsavedCopies } from "./docStore.ts";

/**
 * Holds the lock named after a screen's copy until it's released. `held` resolves once it's held,
 * or at once when it can't be (no Web Locks).
 */
export function holdCopy(key: string): { held: Promise<void>; release(): void } {
  let release = () => {};
  const until = new Promise<void>((done) => {
    release = done;
  });
  const held = new Promise<void>((resolve) => {
    try {
      navigator.locks
        .request(key, () => {
          resolve();
          return until;
        })
        .catch(() => resolve());
    } catch {
      resolve();
    }
  });
  return { held, release: () => release() };
}

/**
 * The copies kept for one record ("canvas:<id>"), `own` left out, whose screens hold no lock: they
 * have closed or crashed (or ran an older Hearth). Without Web Locks there's no telling, so none:
 * each screen saves its own, and a copy whose screen closed before saving it stays on this device
 * (signing out warns of it).
 */
export async function closedCopies<T>(key: string, own: string): Promise<Unsaved<T>[]> {
  // Read before the locks: a screen holds its lock before it keeps a copy, so one whose lock is
  // free afterwards has closed.
  const copies = (await unsavedCopies<T>(key)).filter((k) => k.key !== own);
  if (!copies.length) return copies;
  try {
    const { held = [] } = await navigator.locks.query();
    const open = new Set(held.map((lock) => lock.name));
    return copies.filter((k) => !open.has(k.key));
  } catch {
    return [];
  }
}
