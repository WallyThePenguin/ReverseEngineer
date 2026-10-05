// Gmail as a MailProvider: history.list for what changed, raw messages, and label changes. No
// push notifications, so nothing on your PC has to accept connections from Google. Every call
// says what it costs, so the shared budget can pace it (D55).
import type { DbOrTx } from "@hearth/db";
import {
  type MailChange,
  type MailChanges,
  type MailErrorKind,
  type MailProvider,
  MailProviderError,
  type RawMail,
} from "../mail/provider.ts";
import { GMAIL_COST } from "./budget.ts";
import type { GoogleClient } from "./client.ts";
import { GoogleApiError, type GoogleErrorKind } from "./errors.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
/** A first sync brings in this many days of mail, up to FIRST_SYNC_MAX messages. */
export const FIRST_SYNC_DAYS = 30;
export const FIRST_SYNC_MAX = 1000;
const PAGE = 100;
/** History is read up to about this many messages at a time; the rest waits for the next call. */
export const CHANGES_PER_CALL = 200;
/** Before a send, this many of the newest sent messages are checked for Hearth's own header. */
const SENT_CHECKS = 5;

interface GMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  raw?: string;
}

interface GHistory {
  id: string;
  messagesAdded?: { message: GMessage }[];
  messagesDeleted?: { message: GMessage }[];
  labelsAdded?: { message: GMessage; labelIds?: string[] }[];
  labelsRemoved?: { message: GMessage; labelIds?: string[] }[];
}

const KINDS: Record<GoogleErrorKind, MailErrorKind> = {
  rate_limited: "slow_down",
  paced: "paced",
  auth: "auth",
  transient: "transient",
  not_found: "gone",
  refused: "refused",
};

export class GmailProvider implements MailProvider {
  readonly name = "gmail";
  private readonly google: GoogleClient;
  private readonly db: DbOrTx;

  constructor(google: GoogleClient, db: DbOrTx) {
    this.google = google;
    this.db = db;
  }

  private async call<T>(
    address: string,
    method: string,
    path: string,
    cost: number,
    body?: unknown,
    // A send, or a call a send waits on: it may use the budget's headroom.
    priority = cost === GMAIL_COST.send,
  ): Promise<T> {
    try {
      return await this.google.call<T>(this.db, address, method, `${BASE}${path}`, body, {
        cost,
        priority,
      });
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err;
      throw new MailProviderError(err.message, KINDS[err.kind], err.retryAfterMs, err.reason);
    }
  }

  async changes(address: string, cursor: Record<string, unknown> | null): Promise<MailChanges> {
    const historyId = typeof cursor?.historyId === "string" ? cursor.historyId : null;
    if (!historyId || cursor?.pageToken !== undefined) return this.firstSync(address, cursor);
    const changed = new Map<string, MailChange>();
    const removed = new Set<string>();
    const touch = (m: GMessage, labels: string[] | undefined) => {
      const c = changed.get(m.id) ?? { id: m.id, labels: null, added: false, inboxed: false };
      // The last record's labels are the newest; one without them leaves them unknown.
      c.labels = labels ?? null;
      changed.set(m.id, c);
      return c;
    };
    let page: string | undefined;
    let latest = historyId;
    let stoppedAt: string | null = null;
    try {
      do {
        const q = new URLSearchParams({
          startHistoryId: historyId,
          maxResults: "500",
          ...(page ? { pageToken: page } : {}),
        });
        const res = await this.call<{
          history?: GHistory[];
          historyId?: string;
          nextPageToken?: string;
        }>(address, "GET", `/history?${q}`, GMAIL_COST.history);
        for (const h of res.history ?? []) {
          for (const x of h.messagesAdded ?? []) touch(x.message, x.message.labelIds).added = true;
          for (const x of h.labelsAdded ?? []) {
            const c = touch(x.message, x.message.labelIds);
            if (x.labelIds?.includes("INBOX")) c.inboxed = true;
          }
          for (const x of h.labelsRemoved ?? []) touch(x.message, x.message.labelIds);
          for (const x of h.messagesDeleted ?? []) removed.add(x.message.id);
          // Enough for one go: the next call starts after this record.
          if (changed.size + removed.size >= CHANGES_PER_CALL) {
            stoppedAt = h.id;
            break;
          }
        }
        latest = res.historyId ?? latest;
        page = res.nextPageToken;
      } while (page && !stoppedAt);
    } catch (err) {
      // Gmail keeps about a week of history; after that, start again from recent mail.
      if (err instanceof MailProviderError && err.gone)
        return { ...(await this.firstSync(address, null)), restarted: true };
      throw err;
    }
    for (const id of removed) changed.delete(id);
    return {
      cursor: { historyId: stoppedAt ?? latest },
      changed: [...changed.values()],
      removed: [...removed],
      more: stoppedAt !== null,
    };
  }

  async check(address: string): Promise<void> {
    await this.call(address, "GET", "/profile", GMAIL_COST.profile);
  }

  /** Recent mail, a page at a time; history picks up from where the first page started. */
  private async firstSync(
    address: string,
    cursor: Record<string, unknown> | null,
  ): Promise<MailChanges> {
    let historyId = typeof cursor?.historyId === "string" ? cursor.historyId : null;
    if (!historyId) {
      const profile = await this.call<{ historyId: string }>(
        address,
        "GET",
        "/profile",
        GMAIL_COST.profile,
      );
      historyId = profile.historyId;
    }
    // "fetched" is what cursors from before D55 called it.
    const before = Number(cursor?.listed ?? cursor?.fetched ?? 0) || 0;
    const pageToken = typeof cursor?.pageToken === "string" ? cursor.pageToken : undefined;
    const q = new URLSearchParams({
      q: `newer_than:${FIRST_SYNC_DAYS}d -in:chats -in:drafts`,
      maxResults: String(PAGE),
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await this.call<{
      messages?: GMessage[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(address, "GET", `/messages?${q}`, GMAIL_COST.list);
    const ids = (res.messages ?? []).map((m) => m.id);
    const listed = before + ids.length;
    const estimate = Math.max(Number(cursor?.target ?? 0) || 0, res.resultSizeEstimate ?? 0);
    const target = Math.max(listed, Math.min(estimate, FIRST_SYNC_MAX));
    const more = Boolean(res.nextPageToken) && listed < FIRST_SYNC_MAX;
    return {
      cursor: more ? { historyId, pageToken: res.nextPageToken, listed, target } : { historyId },
      changed: ids.map((id) => ({ id, labels: null, added: true, inboxed: false })),
      removed: [],
      more,
      backfill: { listed, target },
    };
  }

  async fetch(address: string, id: string, urgent = false): Promise<RawMail | null> {
    try {
      const m = await this.call<GMessage>(
        address,
        "GET",
        `/messages/${encodeURIComponent(id)}?format=raw`,
        GMAIL_COST.get,
        undefined,
        urgent,
      );
      return m.raw
        ? { providerId: m.id, labels: m.labelIds ?? [], raw: Buffer.from(m.raw, "base64url") }
        : null;
    } catch (err) {
      if (err instanceof MailProviderError && err.gone) return null;
      throw err;
    }
  }

  async labels(address: string, id: string): Promise<string[] | null> {
    try {
      const m = await this.call<GMessage>(
        address,
        "GET",
        `/messages/${encodeURIComponent(id)}?format=minimal`,
        GMAIL_COST.get,
      );
      return m.labelIds ?? [];
    } catch (err) {
      if (err instanceof MailProviderError && err.gone) return null;
      throw err;
    }
  }

  async modify(address: string, ids: string[], add: string[], remove: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1000)
      await this.call<null>(address, "POST", "/messages/batchModify", GMAIL_COST.batchModify, {
        ids: ids.slice(i, i + 1000),
        addLabelIds: add,
        removeLabelIds: remove,
      });
  }

  async send(address: string, raw: Buffer): Promise<{ providerId: string }> {
    const sent = await this.call<GMessage>(address, "POST", "/messages/send", GMAIL_COST.send, {
      raw: raw.toString("base64url"),
    });
    return { providerId: sent.id };
  }

  async findSent(address: string, messageId: string, since: Date): Promise<string | null> {
    const list = async (q: string, max: number) => {
      const params = new URLSearchParams({ q, maxResults: String(max), includeSpamTrash: "true" });
      const res = await this.call<{ messages?: GMessage[] }>(
        address,
        "GET",
        `/messages?${params}`,
        GMAIL_COST.list,
        undefined,
        true,
      );
      return res.messages ?? [];
    };
    const [byId] = await list(`rfc822msgid:${messageId}`, 1);
    if (byId) return byId.id;
    // Gmail may give a message sent through its API a Message-ID of its own; Hearth's header stays.
    const after = Math.floor(since.getTime() / 1000) - 60;
    for (const m of await list(`in:sent after:${after}`, SENT_CHECKS)) {
      const meta = await this.call<{ payload?: { headers?: { name: string; value: string }[] } }>(
        address,
        "GET",
        `/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=X-Hearth-Id`,
        GMAIL_COST.get,
        undefined,
        true,
      );
      const ours = meta.payload?.headers?.find((h) => h.name.toLowerCase() === "x-hearth-id");
      if (ours?.value.trim() === messageId) return m.id;
    }
    return null;
  }
}
