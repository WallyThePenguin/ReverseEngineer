// Mail as the app and Jarvis read it: conversation lists, a conversation in full, and an HTML
// message made safe to show (inline images in, everything remote out until you ask).
import {
  type DbOrTx,
  entity,
  type MailAddress,
  type MailAttachment,
  type MailLane,
  mailAccount,
  mailMessage,
  mailThread,
} from "@hearth/db";
import { and, asc, desc, eq, inArray, isNotNull, lt, type SQL, sql } from "drizzle-orm";
import { loadEvent } from "../calendar/store.ts";
import type { BlobStore } from "./blobs.ts";
import { matchInvite } from "./invites.ts";
import { parseMail } from "./mime.ts";

export interface ThreadSummary {
  id: string;
  subject: string;
  snippet: string;
  account: string;
  participants: MailAddress[];
  lastMessageAt: Date;
  messageCount: number;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  trashed: boolean;
  lane: MailLane;
  /** "you": it needs your reply. "them": you wrote last and are waiting. */
  waiting: "you" | "them" | null;
  waitingSince: Date | null;
}

export interface MessageView {
  id: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  sentAt: Date;
  text: string;
  hasHtml: boolean;
  outbound: boolean;
  unread: boolean;
  attachments: MailAttachment[];
  /** A calendar invitation, matched to the event on your calendar when there is one. */
  invite: InviteView | null;
}

export interface InviteView {
  method: string;
  /** The email's own name for it: written by the sender. */
  summary: string;
  /** The event on your calendar, as the calendar has it. */
  event: {
    id: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    allDay: boolean;
    cancelled: boolean;
    response: string | null;
    selfOrganizer: boolean;
    /** One time of a repeating meeting: an answer is for this time or every time. */
    recurring: boolean;
  } | null;
}

export interface ThreadView extends ThreadSummary {
  messages: MessageView[];
}

export type MailView = "inbox" | "starred" | "sent" | "all" | "trash";

const summaryFields = {
  id: mailThread.entityId,
  subject: entity.title,
  snippet: mailThread.snippet,
  account: mailAccount.address,
  participants: mailThread.participants,
  lastMessageAt: mailThread.lastMessageAt,
  messageCount: mailThread.messageCount,
  unread: mailThread.unread,
  starred: mailThread.starred,
  inInbox: mailThread.inInbox,
  trashed: mailThread.trashed,
  lane: mailThread.lane,
  waiting: mailThread.waiting,
  waitingSince: mailThread.waitingSince,
};

function viewFilter(view: MailView | "any"): SQL | undefined {
  const live = eq(mailThread.trashed, false);
  switch (view) {
    case "inbox":
      return and(live, eq(mailThread.inInbox, true));
    case "starred":
      return and(live, eq(mailThread.starred, true));
    case "sent":
      return and(live, isNotNull(mailThread.lastOutboundAt));
    case "trash":
      return eq(mailThread.trashed, true);
    case "any":
      return undefined;
    default:
      return live;
  }
}

export async function listThreads(
  db: DbOrTx,
  q: {
    view: MailView | "any";
    lane?: MailLane;
    account?: string;
    unread?: boolean;
    before?: Date;
    ids?: string[];
    /** Only conversations waiting on you (or on them), longest-waiting first. */
    waiting?: "you" | "them";
    limit: number;
  },
): Promise<ThreadSummary[]> {
  return db
    .select(summaryFields)
    .from(mailThread)
    .innerJoin(entity, eq(entity.id, mailThread.entityId))
    .innerJoin(mailAccount, eq(mailAccount.id, mailThread.accountId))
    .where(
      and(
        viewFilter(q.view),
        q.lane ? eq(mailThread.lane, q.lane) : undefined,
        q.account ? eq(mailAccount.address, q.account.toLowerCase()) : undefined,
        q.unread !== undefined ? eq(mailThread.unread, q.unread) : undefined,
        q.before ? lt(mailThread.lastMessageAt, q.before) : undefined,
        q.ids ? inArray(mailThread.entityId, q.ids) : undefined,
        q.waiting ? eq(mailThread.waiting, q.waiting) : undefined,
      ),
    )
    .orderBy(q.waiting ? asc(mailThread.waitingSince) : desc(mailThread.lastMessageAt))
    .limit(q.limit);
}

/** Conversations whose subject or any message matches a search, newest first. */
export async function searchThreads(db: DbOrTx, query: string, limit: number) {
  const tsq = sql`websearch_to_tsquery('english', ${query})`;
  const hits = await db
    .selectDistinct({ id: sql<string>`coalesce(${mailMessage.threadId}, ${entity.id})` })
    .from(entity)
    .leftJoin(mailMessage, eq(mailMessage.entityId, entity.id))
    .where(
      and(inArray(entity.type, ["email", "email_thread"]), sql`${sql.raw("search")} @@ ${tsq}`),
    )
    .limit(500);
  if (hits.length === 0) return [];
  return listThreads(db, { view: "all", ids: hits.map((h) => h.id), limit });
}

export async function loadThread(db: DbOrTx, id: string): Promise<ThreadView | null> {
  const [summary] = await listThreads(db, { view: "any", ids: [id], limit: 1 });
  if (!summary) return null;
  const rows = await db
    .select({ m: mailMessage, text: entity.body })
    .from(mailMessage)
    .innerJoin(entity, eq(entity.id, mailMessage.entityId))
    .where(eq(mailMessage.threadId, id))
    .orderBy(asc(mailMessage.sentAt));
  const invites = new Map<string, InviteView>();
  // The newest few: a conversation full of invitations doesn't slow every view.
  for (const { m } of rows.filter((r) => r.m.invite).slice(-10)) {
    if (!m.invite) continue;
    const eventId = await matchInvite(db, m.invite);
    const ev = eventId ? await loadEvent(db, eventId) : null;
    invites.set(m.entityId, {
      method: m.invite.method,
      summary: m.invite.summary,
      event: ev && {
        id: ev.id,
        title: ev.title,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        allDay: ev.allDay,
        cancelled: ev.status === "cancelled",
        response: ev.selfResponse,
        selfOrganizer: ev.selfOrganizer,
        recurring: Boolean(ev.recurringEventId),
      },
    });
  }
  return {
    ...summary,
    messages: rows.map(({ m, text }) => ({
      id: m.entityId,
      from: { address: m.fromAddress, ...(m.fromName ? { name: m.fromName } : {}) },
      to: m.toAddresses,
      cc: m.ccAddresses,
      sentAt: m.sentAt,
      text: text ?? "",
      hasHtml: m.hasHtml,
      outbound: m.outbound,
      unread: m.labels.includes("UNREAD"),
      attachments: m.attachments,
      invite: invites.get(m.entityId) ?? null,
    })),
  };
}

export const who = (a: MailAddress) => (a.name ? `${a.name} <${a.address}>` : a.address);

function inviteLine(i: InviteView): string {
  if (i.method === "CANCEL")
    return i.event?.cancelled
      ? `Cancels calendar event ${i.event.id}, and the calendar shows it cancelled.`
      : `The sender says "${i.summary}" is cancelled; the calendar doesn't show that.`;
  if (!i.event) return `Invitation "${i.summary}": not on the calendar yet.`;
  const answer = i.event.response ?? "not answered";
  const repeats = i.event.recurring ? ' It repeats: say scope "this" or "all".' : "";
  return `Invitation: calendar event ${i.event.id} (owner's answer: ${answer}). Answer it with calendar_respond if the owner asks.${repeats}`;
}

/** A conversation as markdown, for Jarvis. Quoted replies are cut to keep it short. */
export function threadText(t: ThreadView, maxPerMessage = 4000): string {
  const head = [
    `# ${t.subject}`,
    `id: ${t.id} · email conversation · ${t.account} · ${t.messageCount} messages · ${t.lane}${
      t.inInbox ? " · in inbox" : " · archived"
    }${t.unread ? " · unread" : ""}${t.starred ? " · starred" : ""}`,
  ];
  const body = t.messages.map((m) => {
    const own = m.text
      .split("\n")
      .filter((l) => !l.startsWith(">"))
      .join("\n")
      .trim();
    const files = m.attachments.filter((a) => !a.inline).map((a) => a.filename);
    return [
      `## ${m.outbound ? "You" : who(m.from)}, ${m.sentAt.toISOString()} (message ${m.id})`,
      `To: ${m.to.map(who).join(", ")}${m.cc.length ? ` · Cc: ${m.cc.map(who).join(", ")}` : ""}`,
      ...(files.length ? [`Attachments: ${files.join(", ")}`] : []),
      ...(m.invite ? [inviteLine(m.invite)] : []),
      "",
      own.length > maxPerMessage ? `${own.slice(0, maxPerMessage)}…` : own,
    ].join("\n");
  });
  return [...head, "", ...body].join("\n\n");
}

/** An image the message carries itself, shown inline; larger ones are left out. */
const INLINE_MAX = 2_000_000;

/**
 * A message's HTML, made safe to show: images it carries are inlined, and the app shows it in a
 * sandboxed frame that runs no scripts and loads nothing remote until you ask.
 */
export async function messageHtml(
  db: DbOrTx,
  blobs: BlobStore,
  id: string,
): Promise<{ html: string; remoteImages: boolean } | null> {
  const [m] = await db.select().from(mailMessage).where(eq(mailMessage.entityId, id));
  if (!m) return null;
  const raw = await blobs.get(m.rawHash);
  if (!raw) return null;
  const p = await parseMail(raw);
  let html = p.html ?? "";
  for (const a of p.attachments) {
    if (!a.contentId || a.size > INLINE_MAX || !a.mimeType.startsWith("image/")) continue;
    const data = `data:${a.mimeType};base64,${a.content.toString("base64")}`;
    html = html.replaceAll(`cid:${a.contentId}`, data);
  }
  return {
    html,
    remoteImages: /<img[^>]+src=["']?https?:/i.test(html) || /url\(["']?https?:/i.test(html),
  };
}

/** One attachment from a message's original, for downloading. */
export async function messageAttachment(
  db: DbOrTx,
  blobs: BlobStore,
  id: string,
  index: number,
): Promise<{ filename: string; mimeType: string; content: Buffer } | null> {
  const [m] = await db.select().from(mailMessage).where(eq(mailMessage.entityId, id));
  const raw = m ? await blobs.get(m.rawHash) : null;
  if (!raw) return null;
  const a = (await parseMail(raw)).attachments[index];
  return a ? { filename: a.filename, mimeType: a.mimeType, content: a.content } : null;
}
