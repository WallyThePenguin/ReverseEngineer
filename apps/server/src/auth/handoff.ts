// The desktop app's sign-in hand-off (D53). Signed in in your browser, you ask Hearth to connect
// the PC: Hearth makes a nonce and your browser opens hearth://connect?nonce=… . The app trades
// the nonce for its device token and a code, and its window trades the code for a session.
//
// Nonces and codes are single-use, last a minute, and live only in this process's memory: a
// restart forgets them, which only means clicking Connect again. Only their hashes are kept, and
// a lookup compares every one in constant time.
import { createHash, randomBytes } from "node:crypto";
import { safeEqual } from "./tokens.ts";

export const HANDOFF_TTL_MS = 60_000;
/** Plenty for one person clicking Connect; more pending than this and the oldest go. */
const MAX_PENDING = 20;

interface Pending {
  hash: string;
  principal: string;
  expiresAt: number;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("base64url");

class SingleUse {
  private pending: Pending[] = [];
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  issue(principal: string): string {
    const secret = randomBytes(32).toString("base64url");
    this.prune();
    this.pending.push({ hash: hash(secret), principal, expiresAt: this.now() + HANDOFF_TTL_MS });
    while (this.pending.length > MAX_PENDING) this.pending.shift();
    return secret;
  }

  /** The principal the secret was issued for, once; null when unknown, used or expired. */
  take(secret: unknown): string | null {
    if (typeof secret !== "string" || secret.length < 16 || secret.length > 128) return null;
    const h = hash(secret);
    let found: Pending | null = null;
    for (const p of this.pending) if (safeEqual(p.hash, h)) found = p;
    if (!found) return null;
    this.pending = this.pending.filter((p) => p !== found);
    return found.expiresAt > this.now() ? found.principal : null;
  }

  private prune() {
    const now = this.now();
    this.pending = this.pending.filter((p) => p.expiresAt > now);
  }
}

export class Handoffs {
  /** Made by a signed-in browser, taken by the desktop app (hearth://connect). */
  readonly nonces: SingleUse;
  /** Given to the desktop app, taken by its window to sign in. */
  readonly codes: SingleUse;

  constructor(now: () => number = () => Date.now()) {
    this.nonces = new SingleUse(now);
    this.codes = new SingleUse(now);
  }
}

/** The one this server uses; tests can make their own. */
export const handoffs = new Handoffs();
