// Gmail as a MailProvider: history.list for what changed, raw messages, and label changes. No
// push notifications, so nothing on your PC has to accept connections from Google.
import type { DbOrTx } from "@hearth/db";
import {
  type MailChanges,
  type MailProvider,
  MailProviderError,
  type RawMail,
} from "../mail/provider.ts";
import { GoogleApiError, type GoogleClient } from "./client.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
/** A first sync brings in this many days of mail, up to FIRST_SYNC_MAX messages. */
export const FIRST_SYNC_DAYS = 30;
export const FIRST_SYNC_MAX = 1000;
const PAGE = 100;
const PARALLEL = 8;

interface GMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  raw?: string;
}

interface GHistory {
  messagesAdded?: { message: GMessage }[];
  messagesDeleted?: { message: GMessage }[];
  labelsAdded?: { message: GMessage }[];
  labelsRemoved?: { message: GMessage }[];
}

/** Runs `fn` over `items`, a few at a time. */
async function inParallel<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += PARALLEL)
    out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  return out;
}

export class GmailProvider implements MailProvider {
  readonly name = "gmail";
  private readonly google: GoogleClient;
  private readonly db: DbOrTx;

  constructor(google: GoogleClient, db: DbOrTx) {
    this.google = google;
    this.db = db;
  }

  private async call<T>(address: string, method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.google.call<T>(this.db, address, method, `${BASE}${path}`, body);
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err;
      const limited = err.status === 429 || (err.status === 403 && /rate|quota/i.test(err.message));
      const permanent = !limited && err.status >= 400 && err.status < 500;
      throw new MailProviderError(err.message, permanent, err.status === 404);
    }
  }

  async changes(address: string, cursor: Record<string, unknown> | null): Promise<MailChanges> {
    const historyId = typeof cursor?.historyId === "string" ? cursor.historyId : null;
    if (!historyId || cursor?.pageToken !== undefined) return this.firstSync(address, cursor);
    const changed = new Set<string>();
    const removed = new Set<string>();
    let page: string | undefined;
    let latest = historyId;
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
        }>(address, "GET", `/history?${q}`);
        for (const h of res.history ?? []) {
          for (const x of [
            ...(h.messagesAdded ?? []),
            ...(h.labelsAdded ?? []),
            ...(h.labelsRemoved ?? []),
          ])
            changed.add(x.message.id);
          for (const x of h.messagesDeleted ?? []) removed.add(x.message.id);
        }
        latest = res.historyId ?? latest;
        page = res.nextPageToken;
      } while (page);
    } catch (err) {
      // Gmail keeps about a week of history; after that, start again from recent mail.
      if (err instanceof MailProviderError && err.gone)
        return { ...(await this.firstSync(address, null)), restarted: true };
      throw err;
    }
    for (const id of removed) changed.delete(id);
    return {
      cursor: { historyId: latest },
      changed: [...changed],
      removed: [...removed],
      more: false,
    };
  }

  /** Recent mail, a page at a time; history picks up from where the first page started. */
  private async firstSync(
    address: string,
    cursor: Record<string, unknown> | null,
  ): Promise<MailChanges> {
    let historyId = typeof cursor?.historyId === "string" ? cursor.historyId : null;
    if (!historyId) {
      const profile = await this.call<{ historyId: string }>(address, "GET", "/profile");
      historyId = profile.historyId;
    }
    const fetched = typeof cursor?.fetched === "number" ? cursor.fetched : 0;
    const pageToken = typeof cursor?.pageToken === "string" ? cursor.pageToken : undefined;
    const q = new URLSearchParams({
      q: `newer_than:${FIRST_SYNC_DAYS}d -in:chats`,
      maxResults: String(PAGE),
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await this.call<{ messages?: GMessage[]; nextPageToken?: string }>(
      address,
      "GET",
      `/messages?${q}`,
    );
    const ids = (res.messages ?? []).map((m) => m.id);
    const total = fetched + ids.length;
    const more = Boolean(res.nextPageToken) && total < FIRST_SYNC_MAX;
    return {
      cursor: more ? { historyId, pageToken: res.nextPageToken, fetched: total } : { historyId },
      changed: ids,
      removed: [],
      more,
    };
  }

  async fetch(address: string, ids: string[]): Promise<RawMail[]> {
    const got = await inParallel(ids, async (id): Promise<RawMail | null> => {
      try {
        const m = await this.call<GMessage>(
          address,
          "GET",
          `/messages/${encodeURIComponent(id)}?format=raw`,
        );
        return m.raw
          ? { providerId: m.id, labels: m.labelIds ?? [], raw: Buffer.from(m.raw, "base64url") }
          : null;
      } catch (err) {
        if (err instanceof MailProviderError && err.gone) return null;
        throw err;
      }
    });
    return got.filter((m): m is RawMail => m !== null);
  }

  async labels(address: string, ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    await inParallel(ids, async (id) => {
      try {
        const m = await this.call<GMessage>(
          address,
          "GET",
          `/messages/${encodeURIComponent(id)}?format=minimal`,
        );
        out.set(m.id, m.labelIds ?? []);
      } catch (err) {
        if (!(err instanceof MailProviderError && err.gone)) throw err;
      }
    });
    return out;
  }

  async modify(address: string, ids: string[], add: string[], remove: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1000)
      await this.call<null>(address, "POST", "/messages/batchModify", {
        ids: ids.slice(i, i + 1000),
        addLabelIds: add,
        removeLabelIds: remove,
      });
  }

  async send(address: string, raw: Buffer): Promise<{ providerId: string }> {
    const sent = await this.call<GMessage>(address, "POST", "/messages/send", {
      raw: raw.toString("base64url"),
    });
    return { providerId: sent.id };
  }
}
