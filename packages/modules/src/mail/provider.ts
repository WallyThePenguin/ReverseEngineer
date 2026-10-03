// What Hearth needs from a mail service (D15). Gmail is the first adapter; Microsoft 365 and
// IMAP are each one more class like it. Flags use Gmail's words (INBOX, UNREAD, STARRED, TRASH,
// SENT, CATEGORY_PROMOTIONS...), which other adapters map their folders and flags onto.

export interface RawMail {
  providerId: string;
  labels: string[];
  raw: Buffer;
}

export interface MailChanges {
  /** Where the next call starts. */
  cursor: Record<string, unknown>;
  /** Messages that are new, or whose flags may have changed. */
  changed: string[];
  /** Messages that are gone for good. */
  removed: string[];
  /** There's more to fetch right away (a first sync comes in pages). */
  more: boolean;
  /** The provider lost track of where Hearth was, so this is a fresh start. */
  restarted?: boolean;
}

export interface MailProvider {
  readonly name: string;
  /** What changed since the cursor; with no cursor, recent mail to start from. */
  changes(address: string, cursor: Record<string, unknown> | null): Promise<MailChanges>;
  /** Whole messages. Ones that no longer exist are left out. */
  fetch(address: string, ids: string[]): Promise<RawMail[]>;
  /** Current flags of messages Hearth already has. Ones that no longer exist are left out. */
  labels(address: string, ids: string[]): Promise<Map<string, string[]>>;
  modify(address: string, ids: string[], add: string[], remove: string[]): Promise<void>;
  /** Sends a raw message (its Bcc header is used for delivery and not shown to others). */
  send(address: string, raw: Buffer): Promise<{ providerId: string }>;
}

/** A refusal from the provider. Permanent ones are rolled back instead of retried. */
export class MailProviderError extends Error {
  readonly permanent: boolean;
  /** The message (or the provider's bookmark) doesn't exist there any more. */
  readonly gone: boolean;
  constructor(message: string, permanent: boolean, gone = false) {
    super(message);
    this.permanent = permanent;
    this.gone = gone;
    this.name = "MailProviderError";
  }
}
