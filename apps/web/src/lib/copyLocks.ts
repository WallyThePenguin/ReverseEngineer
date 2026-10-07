// Which kept copies of a board, a spreadsheet or meeting notes belong to screens still open (D59).
// Each screen keeps its own copy of what Hearth doesn't have yet (wholeSave.ts), and holds a Web
// Lock named after it from before it first keeps it until it closes; the browser lets a lock go
// with the tab that held it. Another screen takes over only copies whose lock is free, so not an
// open screen's: that one saves its own, and a card it removes afterwards stays removed. (A screen
// still running an older Hearth holds no lock, so its copy is taken over as before.) Without Web
// Locks (a page on plain http, an older browser) there's no telling, so every other copy is taken
// over, as Hearth did before it held these locks: a copy whose tab closed is still sent, and in the
// rare case its screen is still open, a card that screen removes afterwards can come back.

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
 * have closed or crashed (or ran an older Hearth). Each is as its screen left it. Without Web Locks
 * there's no telling, so all of them.
 */
export async function closedCopies<T>(key: string, own: string): Promise<Unsaved<T>[]> {
  const copies = (await unsavedCopies<T>(key)).filter((k) => k.key !== own);
  if (!copies.length || typeof navigator === "undefined" || !navigator.locks) return copies;
  const closed: Unsaved<T>[] = [];
  for (const k of copies) {
    const now = await ifClosed<T>(key, k.key);
    if (now) closed.push(now);
  }
  return closed;
}

/**
 * One screen's copy as it is now, if that screen holds no lock; undefined if it does (it's open),
 * or if the lock can't be asked for.
 */
async function ifClosed<T>(key: string, copy: string): Promise<Unsaved<T> | undefined> {
  try {
    // Taken only if it's free, and the copy read again while it's held here: a screen holds its
    // lock until its last save on closing is done, so what's read now is what it left (the copy
    // read before may since have changed, or gone).
    return await navigator.locks.request(copy, { ifAvailable: true }, async (lock) =>
      lock ? (await unsavedCopies<T>(key)).find((k) => k.key === copy) : undefined,
    );
  } catch {
    return undefined;
  }
}

/**
 * Calls `then` as each screen whose copy of `key` wasn't taken in (`own` and `taken` left out)
 * lets its lock go. A closing screen holds it until its last save is done, and a save that failed
 * leaves its copy behind for whoever has the record open.
 */
export async function whenLetGo<T>(
  key: string,
  own: string,
  taken: Unsaved<T>[],
  then: () => void,
): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) return;
  const skip = new Set([own, ...taken.map((k) => k.key)]);
  for (const k of await unsavedCopies<T>(key))
    if (!skip.has(k.key)) navigator.locks.request(k.key, async () => {}).then(then, () => {});
}

/**
 * Runs `fn` with the copies kept for `key` whose screens have closed, as they are now, holding each
 * one's lock meanwhile so a screen opening the record doesn't take them in too. Without Web Locks,
 * every copy.
 */
export async function withClosedCopies<T, R>(
  key: string,
  fn: (copies: Unsaved<T>[]) => Promise<R>,
): Promise<R> {
  const copies = await unsavedCopies<T>(key);
  if (typeof navigator === "undefined" || !navigator.locks) return fn(copies);
  const hold = async ([k, ...rest]: Unsaved<T>[], mine: string[]): Promise<R> => {
    if (!k) return fn((await unsavedCopies<T>(key)).filter((c) => mine.includes(c.key)));
    return navigator.locks.request(k.key, { ifAvailable: true }, (lock) =>
      hold(rest, lock ? [...mine, k.key] : mine),
    );
  };
  return hold(copies, []);
}
