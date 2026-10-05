// Which Loro peer this device edits a note as (D59). A fresh random peer for every open note made
// a busy note's version grow by a peer per visit, until syncs were refused. Instead this device
// keeps a few peer ids (in IndexedDB, so they go when its copies of notes go), and an open note
// claims one with a Web Lock for as long as it's open, so two tabs or panes never write as the
// same peer at once. Reusing a peer is safe because every edit is written to IndexedDB before
// it's sent anywhere (doc.ts): the next copy to claim the peer opens with all of its edits.

import { peerFor, retirePeer } from "./docStore.ts";

const SLOTS = 8;

export interface Claim {
  peer: bigint;
  /** Lets another copy of the note take the peer (once this one's edits are written). */
  release(): void;
  /** An edit made as this peer may not have been written: never hand it out again. */
  retire(): void;
}

/** Claims one of this device's peers for a note, or null (no Web Locks or IndexedDB, all taken). */
export async function claimPeer(docId: string): Promise<Claim | null> {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  for (let slot = 0; slot < SLOTS; slot++) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const got = await new Promise<boolean>((resolve) => {
      navigator.locks
        .request(`hearth-doc-peer:${docId}:${slot}`, { ifAvailable: true }, (lock) => {
          resolve(lock !== null);
          // Held until the note closes, or the tab goes.
          return lock ? held : undefined;
        })
        .catch(() => resolve(false));
    });
    if (!got) continue;
    const peer = await peerFor(slot).catch(() => null);
    if (peer === null) {
      release();
      return null;
    }
    return { peer, release, retire: () => void retirePeer(slot) };
  }
  return null;
}
