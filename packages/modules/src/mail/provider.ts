// What Hearth needs from a mail service (D15). Gmail is the first adapter; Microsoft 365 and
// IMAP are each one more class like it. Flags use Gmail's words (INBOX, UNREAD, STARRED, TRASH,
// SENT, CATEGORY_PROMOTIONS...), which other adapters map their folders and flags onto.

export interface RawMail {
  providerId: string;
  labels: string[];
  raw: Buffer;
}

/** One message that changed at the provider. */
export interface MailChange {
  id: string;
  /** Its flags now, when the provider said; null means ask it. */
  labels: string[] | null;
  /** It's new mail: bring it in if Hearth doesn't have it. */
  added: boolean;
  /** It came (back) into the inbox: bring it in too if Hearth doesn't have it. */
  inboxed: boolean;
}

export interface MailChanges {
  /** Where the next call starts, once everything here is handled. */
  cursor: Record<string, unknown>;
  changed: MailChange[];
  /** Messages that are gone for good. */
  removed: string[];
  /** There's more to fetch right away (a first sync comes in pages; a backlog in batches). */
  more: boolean;
  /** The provider lost track of where Hearth was, so this is a fresh start. */
  restarted?: boolean;
  /** Set while bringing in recent mail for the first time: how far along it is. */
  backfill?: { listed: number; target: number };
}

export interface MailProvider {
  readonly name: string;
  /** What changed since the cursor; with no cursor, recent mail to start from. */
  changes(address: string, cursor: Record<string, unknown> | null): Promise<MailChanges>;
  /** One whole message, or null if it no longer exists. */
  fetch(address: string, id: string): Promise<RawMail | null>;
  /** A message's current flags, or null if it no longer exists. */
  labels(address: string, id: string): Promise<string[] | null>;
  /** Changes flags on up to 1,000 messages at once. */
  modify(address: string, ids: string[], add: string[], remove: string[]): Promise<void>;
  /** Sends a raw message (its Bcc header is used for delivery and not shown to others). */
  send(address: string, raw: Buffer): Promise<{ providerId: string }>;
}

/**
 * - slow_down: the provider asked Hearth to slow down; nothing is wrong. `retryAfterMs` says when.
 * - paced: Hearth is holding calls back itself to stay under the provider's limit.
 * - auth: the provider no longer accepts Hearth's access; the account needs connecting again.
 * - transient: a network error, timeout or server error. It may pass by itself.
 * - gone: the message (or the provider's bookmark) doesn't exist there any more.
 * - refused: the provider turned the request down, and would again.
 */
export type MailErrorKind = "slow_down" | "paced" | "auth" | "transient" | "gone" | "refused";

/** A refusal from the provider. Only refused and gone ones are rolled back instead of retried. */
export class MailProviderError extends Error {
  readonly kind: MailErrorKind;
  /** How long to wait before trying again, when that's known. */
  readonly retryAfterMs: number | null;
  constructor(message: string, kind: MailErrorKind, retryAfterMs: number | null = null) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.name = "MailProviderError";
  }

  /** Trying the same thing again won't help. */
  get permanent(): boolean {
    return this.kind === "refused" || this.kind === "gone";
  }

  /** The message (or the provider's bookmark) doesn't exist there any more. */
  get gone(): boolean {
    return this.kind === "gone";
  }

  /** Not a failure: the provider, or Hearth's pacing, says wait. */
  get slowDown(): boolean {
    return this.kind === "slow_down" || this.kind === "paced";
  }
}
