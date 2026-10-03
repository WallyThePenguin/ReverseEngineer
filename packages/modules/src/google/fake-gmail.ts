// A fake Gmail for tests: a mailbox in memory with history, labels and sending, answering the
// calls GmailProvider makes. FakeGoogle hands it every gmail.googleapis.com request.
import { buildMessage, type OutgoingMail } from "../mail/mime.ts";

interface FakeMessage {
  id: string;
  labelIds: string[];
  raw: Buffer;
}

type Entry =
  | { kind: "added" | "deleted"; id: string }
  | { kind: "labels"; id: string; added: boolean };
type Change = Entry & { historyId: number };

export class FakeGmail {
  readonly address: string;
  readonly messages = new Map<string, FakeMessage>();
  readonly sent: Buffer[] = [];
  /** Labels a batchModify will refuse to change (to test rollbacks). */
  refuse = false;
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

  /** Delivers a message, as if it arrived in Gmail. Returns its Gmail id. */
  deliver(
    m: Partial<OutgoingMail> & Pick<OutgoingMail, "from" | "subject" | "text">,
    labels = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
  ): string {
    const id = `m${++this.seq}`;
    const raw = buildMessage({
      to: [{ address: this.address }],
      date: new Date(Date.UTC(2026, 9, 1, 12, this.seq)),
      ...m,
    });
    this.messages.set(id, { id, labelIds: labels, raw });
    this.record({ kind: "added", id });
    return id;
  }

  label(id: string, add: string[], remove: string[]) {
    const m = this.messages.get(id)!;
    m.labelIds = [...new Set([...m.labelIds.filter((l) => !remove.includes(l)), ...add])];
    this.record({ kind: "labels", id, added: add.length > 0 });
  }

  remove(id: string) {
    this.messages.delete(id);
    this.record({ kind: "deleted", id });
  }

  /** Forgets history, so the next sync has to start over. */
  expireHistory() {
    this.oldestHistory = this.historyId + 1;
  }

  handle(u: URL, method: string, body: Record<string, unknown> | undefined): Response {
    const json = (status: number, data: unknown) =>
      new Response(data === null ? null : JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile")
      return json(200, { emailAddress: this.address, historyId: String(this.historyId) });
    if (path === "/messages" && method === "GET") {
      const all = [...this.messages.values()].filter(
        (m) => !m.labelIds.includes("SPAM") && !m.labelIds.includes("TRASH"),
      );
      const size = Number(u.searchParams.get("maxResults") ?? 100);
      const from = Number(u.searchParams.get("pageToken") ?? 0);
      const page = all.reverse().slice(from, from + size);
      return json(200, {
        messages: page.map((m) => ({ id: m.id, threadId: m.id })),
        ...(from + size < all.length ? { nextPageToken: String(from + size) } : {}),
      });
    }
    if (path === "/history") {
      const start = Number(u.searchParams.get("startHistoryId"));
      if (start < this.oldestHistory)
        return json(404, { error: { message: "Requested entity was not found." } });
      const history = this.history
        .filter((h) => h.historyId > start)
        .map((h) => {
          const message = { id: h.id };
          if (h.kind === "added") return { id: String(h.historyId), messagesAdded: [{ message }] };
          if (h.kind === "deleted")
            return { id: String(h.historyId), messagesDeleted: [{ message }] };
          return {
            id: String(h.historyId),
            ["added" in h && h.added ? "labelsAdded" : "labelsRemoved"]: [{ message }],
          };
        });
      return json(200, { history, historyId: String(this.historyId) });
    }
    if (path === "/messages/batchModify" && method === "POST") {
      if (this.refuse) return json(400, { error: { message: "Invalid label" } });
      for (const id of (body?.ids as string[]) ?? [])
        if (this.messages.has(id))
          this.label(
            id,
            (body?.addLabelIds as string[]) ?? [],
            (body?.removeLabelIds as string[]) ?? [],
          );
      return json(204, null);
    }
    if (path === "/messages/send" && method === "POST") {
      const raw = Buffer.from(String(body?.raw ?? ""), "base64url");
      this.sent.push(raw);
      const id = `m${++this.seq}`;
      this.messages.set(id, { id, labelIds: ["SENT"], raw });
      this.record({ kind: "added", id });
      return json(200, { id, threadId: id, labelIds: ["SENT"] });
    }
    const one = path.match(/^\/messages\/([^/]+)$/);
    if (one && method === "GET") {
      const m = this.messages.get(decodeURIComponent(one[1]!));
      if (!m) return json(404, { error: { message: "Requested entity was not found." } });
      const raw = u.searchParams.get("format") === "raw";
      return json(200, {
        id: m.id,
        threadId: m.id,
        labelIds: m.labelIds,
        ...(raw ? { raw: m.raw.toString("base64url") } : {}),
      });
    }
    return json(404, { error: { message: "Not found" } });
  }
}
