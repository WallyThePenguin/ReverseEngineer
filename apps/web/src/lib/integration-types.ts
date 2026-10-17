// The shapes the Google, calendar and mail actions return (see packages/modules/src/calendar
// and packages/modules/src/mail).

export interface CalendarSetup {
  configured: boolean;
  accounts: {
    email: string;
    status: "ok" | "failing" | "revoked";
    lastError: string | null;
    connectedAt: string;
  }[];
  /** One row per account that sees the calendar; a shared one is in each, synced through one. */
  calendars: {
    id: string;
    account: string;
    googleId: string;
    title: string;
    color: string | null;
    isPrimary: boolean;
    canWrite: boolean;
    selected: boolean;
    /** Where Hearth puts new events. */
    writeDefault: boolean;
    lastSyncedAt: string | null;
    lastError: string | null;
  }[];
}

export interface MailAddress {
  address: string;
  name?: string;
}

export interface MailThread {
  id: string;
  subject: string;
  snippet: string;
  account: string;
  participants: MailAddress[];
  lastMessageAt: string;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  trashed: boolean;
  lane: "signal" | "noise";
  waiting: "you" | "them" | null;
  waitingSince: string | null;
}

export interface MailInvite {
  method: string;
  summary: string;
  event: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    cancelled: boolean;
    response: string | null;
    selfOrganizer: boolean;
    /** One time of a repeating meeting. */
    recurring: boolean;
  } | null;
}

export interface MailMessage {
  id: string;
  invite: MailInvite | null;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  sentAt: string;
  text: string;
  hasHtml: boolean;
  outbound: boolean;
  unread: boolean;
  attachments: {
    index: number;
    filename: string;
    mimeType: string;
    size: number;
    inline?: boolean;
  }[];
}

export interface MailThreadView extends MailThread {
  messages: MailMessage[];
}

export interface MailAccount {
  address: string;
  provider: string;
  /** Catching up and paused (Gmail asked Hearth to slow down) are normal; failing isn't. */
  state: "ok" | "catching_up" | "paused" | "failing";
  syncedAt: string | null;
  pausedUntil: string | null;
  lastError: string | null;
  /** Google wants the account connected again. */
  reconnect: boolean;
  firstSyncDone: boolean;
  /** A first sync's progress: messages brought in, of about how many. */
  backfill: { fetched: number; target: number } | null;
  /** Messages still to bring in or look up, and ones that failed, waiting to be tried again. */
  waiting: number;
  /** Messages that failed to come in a few times, set aside: tried again once a day. */
  setAside: number;
  pendingChanges: number;
}

export interface MailDraft {
  id: string;
  /** Null for a draft kept from a disconnected account, until you pick a From. */
  account: string | null;
  threadId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  updatedAt: string;
  /** Raised by every change: a save names the one it was made on, and a Send the one it saw. */
  version: number;
  /** Who started it: Jarvis, or you. */
  by: "jarvis" | "owner";
}
