// A fake Gmail for tests: a mailbox in memory with history, labels and sending, answering the
// calls GmailProvider makes. FakeGoogle hands it every gmail.googleapis.com request. Like the
// real one it counts quota units per call, and can be set to turn calls away past a limit.
import { buildMessage, type OutgoingMail } from "../mail/mime.ts";

interface FakeMessage {
  id: string;
  labelIds: string[];
  raw: Buffer;
  /** When it arrived or was sent, for "after:" searches. */
  at: number;
  /** Gmail's conversation: its own id unless it was sent into another's. */
  threadId?: string;
}

/** One header of a raw message, unfolded. */
function headerOf(raw: Buffer, name: string): string | null {
  const head = raw.toString("utf8").split(/\r?\n\r?\n/)[0] ?? "";
  const m = head.replace(/\r?\n[ \t]+/g, " ").match(new RegExp(`^${name}:[ \\t]*(.*)$`, "im"));
  return m ? m[1]!.trim() : null;
}

/** A message to put in the fake mailbox, with any extra headers (List-Id, Precedence…). */
type FakeMail = Partial<OutgoingMail> &
  Pick<OutgoingMail, "from" | "subject" | "text"> & { headers?: Record<string, string> };

type Entry =
  | { kind: "added" | "deleted"; id: string; labels: string[] }
  | { kind: "labels"; id: string; added: string[]; removed: string[]; labels: string[] };
type Change = Entry & { historyId: number };

/** Gmail's quota units per call. */
function costOf(path: string): number {
  if (path === "/profile") return 1;
  if (path === "/history") return 2;
  if (path === "/messages/batchModify") return 50;
  if (path === "/messages/send") return 100;
  return 5;
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * Google's error replies, as Gmail sends them. `until`: Gmail shuts the account out until then,
 * saying so only in the message, with no Retry-After header.
 */
export function errorReply(status: number, limit?: number, until?: Date): Response {
  if (status === 429 && until) {
    const message = `User-rate limit exceeded.  Retry after ${until.toISOString()}`;
    return json(429, {
      error: {
        code: 429,
        message,
        errors: [{ message, domain: "usageLimits", reason: "rateLimitExceeded" }],
        status: "RESOURCE_EXHAUSTED",
      },
    });
  }
  if (status === 429 || status === 403) {
    const message =
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:1'.";
    return json(status, {
      error: {
        code: status,
        message,
        errors: [
          {
            message,
            domain: "usageLimits",
            reason: status === 429 ? "rateLimitExceeded" : "userRateLimitExceeded",
          },
        ],
        status: status === 429 ? "RESOURCE_EXHAUSTED" : "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            domain: "googleapis.com",
            metadata: { quota_limit_value: String(limit ?? 250), service: "gmail.googleapis.com" },
          },
        ],
      },
    });
  }
  if (status === 400)
    // What Gmail says when it's turned off for the account (a work account's admin did it).
    return json(400, {
      error: {
        code: 400,
        message: "Mail service not enabled",
        errors: [{ message: "Mail service not enabled", reason: "failedPrecondition" }],
        status: "FAILED_PRECONDITION",
      },
    });
  if (status === 401)
    return json(401, {
      error: {
        code: 401,
        message: "Request had invalid authentication credentials.",
        status: "UNAUTHENTICATED",
      },
    });
  return json(status, { error: { code: status, message: "Backend Error", status: "UNAVAILABLE" } });
}

export class FakeGmail {
  readonly address: string;
  readonly messages = new Map<string, FakeMessage>();
  readonly sent: Buffer[] = [];
  /** Labels a batchModify will refuse to change (to test rollbacks). */
  refuse = false;
  /** Messages a batchModify that includes them is refused for. */
  readonly refuseIds = new Set<string>();
  /** Messages that can't be fetched: each get answers with this status. */
  readonly brokenIds = new Map<string, number>();
  /** Messages whose fetch never answers (FakeGoogle waits until the client gives up). */
  readonly hangIds = new Set<string>();
  /** Fetches of those that were left hanging. */
  hung = 0;
  /** The time, for the per-minute limit. FakeGoogle shares its clock. */
  now: () => number = () => Date.now();
  /** Turn calls away (429) past this many units in a rolling window, as Google does. */
  limit: { units: number; windowMs: number } | null = null;
  /** Whether history says what labels each message has (the real one does). */
  historyLabels = true;
  /** The most a list of messages returns a page, whatever Hearth asks for (Gmail may send fewer). */
  pageSize = Number.POSITIVE_INFINITY;
  /** The next `n` sends go out, but the reply is lost (Hearth sees a 503). */
  loseSendReplies = 0;
  /** Sends get a Message-ID of Gmail's own, as Gmail might do for mail sent through its API. */
  rewriteMessageIds = false;
  /** Units spent, all told. */
  units = 0;
  /** Calls turned away by the limit. */
  rejected = 0;
  /** How many times each message was fetched. */
  readonly gets = new Map<string, number>();
  /** Every call: "GET /history", "POST /messages/batchModify"... */
  readonly requests: string[] = [];
  private spent: { at: number; units: number }[] = [];
  private failures: { status: number; after: number; until?: Date }[] = [];
  private historyId = 1000;
  /** History older than this is "expired", as Gmail's is after a week or so. */
  private oldestHistory = 1000;
  private readonly history: Change[] = [];
  private seq = 0;

  constructor(address: string) {
    this.address = address;
  }

  private record(change: Entry) {
    this.history.push({ ...change, historyId: ++this.historyId });
  }

  private build({ headers, ...m }: FakeMail) {
    const id = `m${++this.seq}`;
    const raw = buildMessage({
      to: [{ address: this.address }],
      date: new Date(Date.UTC(2026, 9, 1, 12, this.seq)),
      ...m,
    });
    const extra = Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`);
    return { id, raw: Buffer.concat([Buffer.from(extra.join("")), raw]) };
  }

  /** Delivers a message, as if it arrived in Gmail. Returns its Gmail id. */
  deliver(m: FakeMail, labels = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"]): string {
    const { id, raw } = this.build(m);
    this.messages.set(id, { id, labelIds: labels, raw, at: this.now() });
    this.record({ kind: "added", id, labels });
    return id;
  }

  /** Puts a message in the mailbox with no history, like old mail from before Hearth looked. */
  seed(m: FakeMail, labels = ["CATEGORY_PERSONAL"]): string {
    const { id, raw } = this.build(m);
    this.messages.set(id, { id, labelIds: labels, raw, at: this.now() });
    return id;
  }

  label(id: string, add: string[], remove: string[]) {
    const m = this.messages.get(id)!;
    m.labelIds = [...new Set([...m.labelIds.filter((l) => !remove.includes(l)), ...add])];
    this.record({ kind: "labels", id, added: add, removed: remove, labels: m.labelIds });
  }

  remove(id: string) {
    this.messages.delete(id);
    this.record({ kind: "deleted", id, labels: [] });
  }

  /** Forgets history, so the next sync has to start over. */
  expireHistory() {
    this.oldestHistory = this.historyId + 1;
  }

  /** The next `n` calls (after letting `after` through) fail with `status`. */
  failNext(n: number, status: 400 | 401 | 403 | 429 | 500 | 503, after = 0) {
    for (let i = 0; i < n; i++) this.failures.push({ status, after });
  }

  /** The next call is turned away until `until`, as Gmail's per-user shut-out says it. */
  shutOut(until: Date) {
    this.failures.push({ status: 429, after: 0, until });
  }

  /** Calls made to one path, e.g. "POST /messages/batchModify". */
  count(request: string): number {
    return this.requests.filter((r) => r === request).length;
  }

  handle(u: URL, method: string, body: Record<string, unknown> | undefined): Response {
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    const one = path.match(/^\/messages\/([^/]+)$/);
    this.requests.push(`${method} ${one && method === "GET" ? "/messages/:id" : path}`);
    const failing = this.failures[0];
    if (failing) {
      if (failing.after > 0) failing.after--;
      else {
        this.failures.shift();
        return errorReply(failing.status, undefined, failing.until);
      }
    }
    const cost = costOf(path);
    if (this.limit) {
      const now = this.now();
      this.spent = this.spent.filter((s) => s.at > now - this.limit!.windowMs);
      if (this.spent.reduce((n, s) => n + s.units, 0) + cost > this.limit.units) {
        this.rejected++;
        return errorReply(429, this.limit.units);
      }
      this.spent.push({ at: now, units: cost });
    }
    this.units += cost;
    if (path === "/profile")
      return json(200, { emailAddress: this.address, historyId: String(this.historyId) });
    if (path === "/messages" && method === "GET") {
      // The searches Hearth makes: by Message-ID, and what was sent after a time.
      const q = u.searchParams.get("q") ?? "";
      const msgId = q.match(/rfc822msgid:(\S+)/)?.[1];
      const after = /\bin:sent\b/.test(q) ? Number(q.match(/after:(\d+)/)?.[1] ?? 0) * 1000 : null;
      const all = [...this.messages.values()].filter(
        (m) =>
          (u.searchParams.get("includeSpamTrash") === "true" ||
            (!m.labelIds.includes("SPAM") && !m.labelIds.includes("TRASH"))) &&
          (!msgId || headerOf(m.raw, "Message-ID") === `<${msgId}>`) &&
          (after === null || (m.labelIds.includes("SENT") && m.at >= after)),
      );
      const size = Math.min(Number(u.searchParams.get("maxResults") ?? 100), this.pageSize);
      const from = Number(u.searchParams.get("pageToken") ?? 0);
      const page = all.reverse().slice(from, from + size);
      return json(200, {
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })),
        resultSizeEstimate: all.length,
        ...(from + size < all.length ? { nextPageToken: String(from + size) } : {}),
      });
    }
    if (path === "/history") return this.historyPage(u);
    if (path === "/messages/batchModify" && method === "POST") {
      const ids = (body?.ids as string[]) ?? [];
      if (this.refuse || ids.some((id) => this.refuseIds.has(id)))
        return json(400, { error: { message: "Invalid label" } });
      for (const id of ids)
        if (this.messages.has(id))
          this.label(
            id,
            (body?.addLabelIds as string[]) ?? [],
            (body?.removeLabelIds as string[]) ?? [],
          );
      return json(204, null);
    }
    if (path === "/messages/send" && method === "POST") {
      let raw = Buffer.from(String(body?.raw ?? ""), "base64url");
      const id = `m${++this.seq}`;
      if (this.rewriteMessageIds)
        raw = Buffer.from(
          raw.toString("utf8").replace(/^Message-ID:.*$/im, `Message-ID: <${id}@mail.gmail.com>`),
        );
      this.sent.push(raw);
      // Into the conversation it names, if there's one; else one of its own.
      const into = [...this.messages.values()].find(
        (m) => body?.threadId && (m.threadId ?? m.id) === body.threadId,
      );
      const threadId = into ? String(body!.threadId) : id;
      this.messages.set(id, { id, labelIds: ["SENT"], raw, at: this.now(), threadId });
      this.record({ kind: "added", id, labels: ["SENT"] });
      if (this.loseSendReplies > 0) {
        this.loseSendReplies--;
        return errorReply(503);
      }
      return json(200, { id, threadId, labelIds: ["SENT"] });
    }
    if (one && method === "GET") {
      const id = decodeURIComponent(one[1]!);
      this.gets.set(id, (this.gets.get(id) ?? 0) + 1);
      const broken = this.brokenIds.get(id);
      if (broken) return json(broken, { error: { code: broken, message: "Invalid id value" } });
      const m = this.messages.get(id);
      if (!m) return json(404, { error: { message: "Requested entity was not found." } });
      const format = u.searchParams.get("format");
      const headers = u.searchParams.getAll("metadataHeaders").flatMap((name) => {
        const value = headerOf(m.raw, name);
        return value === null ? [] : [{ name, value }];
      });
      return json(200, {
        id: m.id,
        threadId: m.threadId ?? m.id,
        labelIds: m.labelIds,
        ...(format === "raw" ? { raw: m.raw.toString("base64url") } : {}),
        ...(format === "metadata" ? { payload: { headers } } : {}),
      });
    }
    return json(404, { error: { message: "Not found" } });
  }

  /** history.list: records after startHistoryId, a page at a time, as Gmail shapes them. */
  private historyPage(u: URL): Response {
    const start = Number(u.searchParams.get("startHistoryId"));
    if (start < this.oldestHistory)
      return json(404, { error: { message: "Requested entity was not found." } });
    const size = Number(u.searchParams.get("maxResults") ?? 100);
    const from = Number(u.searchParams.get("pageToken") ?? 0);
    const after = this.history.filter((h) => h.historyId > start);
    const message = (h: Change) => ({
      id: h.id,
      threadId: h.id,
      ...(this.historyLabels && h.kind !== "deleted" ? { labelIds: h.labels } : {}),
    });
    const history = after.slice(from, from + size).map((h) => {
      const base = { id: String(h.historyId), messages: [{ id: h.id, threadId: h.id }] };
      if (h.kind !== "labels")
        return h.kind === "added"
          ? { ...base, messagesAdded: [{ message: message(h) }] }
          : { ...base, messagesDeleted: [{ message: message(h) }] };
      return {
        ...base,
        ...(h.added.length ? { labelsAdded: [{ message: message(h), labelIds: h.added }] } : {}),
        ...(h.removed.length
          ? { labelsRemoved: [{ message: message(h), labelIds: h.removed }] }
          : {}),
      };
    });
    return json(200, {
      ...(history.length ? { history } : {}),
      historyId: String(this.historyId),
      ...(from + size < after.length ? { nextPageToken: String(from + size) } : {}),
    });
  }
}
