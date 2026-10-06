// Today's "Needs you", apart from how it looks: which approvals "Approve all" may cover together,
// who a send would reach that isn't in its conversation (such a send is approved on its own), what
// each says as a row, and what "Approve all" says it did, item by item when something didn't go
// through.

import type { Decided } from "./approvals.ts";
import { who } from "./format.ts";
import { approvalParts, summaryParts } from "./inbox.ts";
import type { Approval, InboxRow, MailAddress, MailDraft, MailThreadView } from "./types.ts";

/** Approvals that ask for the same kind of thing, where the first of them was asked. */
export interface ApprovalGroup {
  /** The kind, or the kind and the approval for one that has to be approved on its own. */
  key: string;
  action: string;
  items: Approval[];
}

/**
 * Approvals in groups by kind, in the order they were asked. One that `alone` picks out (a send to
 * someone new, say) gets a group of its own, so no "Approve all" ever covers it.
 */
export function groupApprovals(
  list: readonly Approval[] | undefined,
  alone: (a: Approval) => boolean = () => false,
): ApprovalGroup[] {
  const groups = new Map<string, ApprovalGroup>();
  for (const a of list ?? []) {
    const key = alone(a) ? `${a.action}#${a.id}` : a.action;
    const group = groups.get(key);
    if (group) group.items.push(a);
    else groups.set(key, { key, action: a.action, items: [a] });
  }
  return [...groups.values()];
}

/**
 * An approval as its card shows it: as the inbox has it when it's there (its title names records
 * by their titles, and says who asks), and otherwise from the approval itself.
 */
export function approvalCard(
  a: Approval,
  row: InboxRow | undefined,
): { what: string; why: string | null; text: string | null } {
  if (row) return approvalParts(row.notification);
  const parts = summaryParts(a.summary);
  return {
    what: `${who(a.requestedBy)} asks: ${parts.what ?? a.action}`,
    why: a.reason || null,
    text: parts.text,
  };
}

// --- Sends ---

interface SendInput {
  id?: unknown;
  snapshot?: { from?: unknown; to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown };
}
const sendInput = (a: Approval): SendInput | null =>
  a.action === "mail.send" && a.input && typeof a.input === "object"
    ? (a.input as SendInput)
    : null;

/** The draft a send would send, by its id. */
export function sendDraftId(a: Approval): string | null {
  const id = sendInput(a)?.id;
  return typeof id === "string" ? id : null;
}

/** The drafts Jarvis already asked to send: they wait in Needs you, so they aren't offered twice. */
export function askedToSend(approvals: readonly Approval[] | undefined): Set<string> {
  return new Set((approvals ?? []).flatMap((a) => sendDraftId(a) ?? []));
}

/** "ana@x.example (Ana Silva)", as a send's snapshot writes an address, back to an address. */
function unshown(s: string): MailAddress {
  const m = /^(\S+?)(?: \((.*)\))?$/.exec(s.trim());
  return m?.[2] ? { address: m[1]!, name: m[2] } : { address: m?.[1] ?? s };
}
const listOf = (v: unknown): MailAddress[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").map(unshown) : [];

/** Who a send goes to, as asked (its snapshot is what a yes sends), or null if it doesn't say. */
export function sendRecipients(
  a: Approval,
): { to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[] } | null {
  const s = sendInput(a)?.snapshot;
  if (!s) return null;
  return { to: listOf(s.to), cc: listOf(s.cc), bcc: listOf(s.bcc) };
}

/** Which of your accounts a send goes from, as asked. */
export function sendFrom(a: Approval): string | null {
  const from = sendInput(a)?.snapshot?.from;
  return typeof from === "string" ? from : null;
}

const key = (a: MailAddress) => a.address.trim().toLowerCase();

/** Everyone already in a conversation: you, whoever wrote in it, and whoever it went to. */
export function participantsOf(
  t: Pick<MailThreadView, "account" | "participants" | "messages">,
): Set<string> {
  const all = new Set([t.account.toLowerCase(), ...t.participants.map(key)]);
  for (const m of t.messages) for (const a of [m.from, ...m.to, ...m.cc]) all.add(key(a));
  return all;
}

/** A reply's recipients who aren't in its conversation yet: it would reach someone new. */
export function strangers(
  d: Pick<MailDraft, "to" | "cc" | "bcc">,
  inThread: ReadonlySet<string>,
): Set<string> {
  return new Set([...d.to, ...d.cc, ...d.bcc].map(key).filter((a) => !inThread.has(a)));
}

/**
 * Who a send would reach, as far as can be told: a reply's recipients against its conversation, a
 * new email (everyone on it is new), or not known yet (its draft or conversation is on its way).
 */
export type Reach =
  | { kind: "reply"; strangers: ReadonlySet<string> }
  | { kind: "new" }
  | { kind: "unknown" };

export function sendReach(
  a: Approval,
  drafts: readonly MailDraft[] | undefined,
  thread: (id: string) => MailThreadView | undefined,
): Reach {
  const draft = drafts?.find((d) => d.id === sendDraftId(a));
  if (!draft) return { kind: "unknown" };
  if (!draft.threadId) return { kind: "new" };
  const t = thread(draft.threadId);
  if (!t) return { kind: "unknown" };
  return { kind: "reply", strangers: strangers(sendRecipients(a) ?? draft, participantsOf(t)) };
}

/** A send "Approve all" may cover: a reply that reaches only people already in it. */
export const coverable = (r: Reach) => r.kind === "reply" && r.strangers.size === 0;

// --- Rows ---

/** Hearth's usual reason for a yes on a send: Today says it once, over the list, not on each row. */
export const SHARED_WHY = "Other people would see this, so it needs your yes.";

/** A reason worth saying on its own row: any but the one Today says over the whole list. */
export const ownWhy = (why: string | null | undefined) => (why && why !== SHARED_WHY ? why : null);

/** People as a row names them: "Dana Ruiz", "Leo Okafor and Priya Nair", "Leo and 2 others". */
export function namesOf(list: readonly MailAddress[]): string {
  const names = list.map((a) => a.name?.trim() || a.address);
  if (names.length > 2) return `${names[0]} and ${names.length - 1} others`;
  return names.join(" and ") || "nobody yet";
}

/** A send or a draft in a few words: a reply to its people, a new email to them, or not known yet. */
export const mailTitle = (to: readonly MailAddress[], reply: boolean | null) =>
  `${reply === null ? "Send to" : reply ? "Reply to" : "Email"} ${namesOf(to)}`;

/**
 * An approval as one row on Today. A send says who it goes to by name and its subject; anything
 * else says what it would do, without "Jarvis asks:". `whole` when the row's line is all there is
 * to it (no text, and no addresses behind names), so its yes can sit on the row itself; any other
 * opens first, so a yes never covers words you haven't seen (D33, D58).
 */
export function askRow(
  a: Approval,
  parts: { what: string; text: string | null },
  reply: boolean | null,
): { title: string; sub: string | null; whole: boolean } {
  const to = sendRecipients(a);
  if (to) {
    const subject = sendInput(a)?.snapshot?.subject;
    return {
      title: mailTitle(to.to, reply),
      sub: typeof subject === "string" ? subject || "(no subject)" : null,
      whole: false,
    };
  }
  const asks = `${who(a.requestedBy)} asks: `;
  const title =
    a.requestedBy === "jarvis" && parts.what.startsWith(asks)
      ? parts.what.slice(asks.length)
      : parts.what;
  return { title, sub: null, whole: parts.text === null };
}

// --- Approve all ---

/** One approval "Approve all" sent a yes for, and how that went. */
export interface ApprovedItem {
  approval: Approval;
  outcome: Decided;
  /** Hearth's reason, when it wasn't done. */
  message: string | null;
}

/** What "Approve all" did: a line, and each one that didn't go through with why. */
export interface ApproveAllResult {
  text: string;
  ok: boolean;
  missed: { id: string; label: string; why: string; draftId: string | null }[];
}

/** An approval in a few words: a send by its subject, anything else by what it would do. */
export function approvalLabel(a: Approval): string {
  const subject = sendInput(a)?.snapshot?.subject;
  if (typeof subject === "string") return `“${subject || "(no subject)"}”`;
  const what = summaryParts(a.summary).what ?? a.action;
  return what.length > 80 ? `${what.slice(0, 79)}…` : what;
}

/**
 * "3 approved." when every one went through; otherwise how many did and how many didn't, with
 * each that didn't and Hearth's reason, so nothing fails quietly.
 */
export function approveAllResult(items: readonly ApprovedItem[]): ApproveAllResult {
  const done = items.filter((i) => i.outcome === "done").length;
  const missed = items
    .filter((i) => i.outcome !== "done")
    .map((i) => ({
      id: i.approval.id,
      label: approvalLabel(i.approval),
      why:
        i.message ??
        (i.outcome === "changed"
          ? "It changed before your yes reached it."
          : "Hearth couldn't do it."),
      draftId: sendDraftId(i.approval),
    }));
  if (!missed.length) return { text: `${done} approved.`, ok: true, missed };
  const didnt = `${missed.length} didn't go through`;
  return { text: done ? `${done} approved, ${didnt}:` : `${didnt}:`, ok: false, missed };
}
