// What a draft shows when it opens. A reply folds Bcc and Subject behind "More", since they come
// from the conversation, but never a Bcc with anyone on it, nor a Subject that isn't just the
// conversation's: nothing an email carries is out of sight when you press Send, whoever filled
// the draft in (Jarvis drafts replies too, and can set the subject). A draft changed elsewhere
// while you type (Jarvis, another screen) is merged into yours, field by field.

import { mergeText } from "@hearth/core";
import type { MailAddress, MailDraft } from "./types.ts";

type Draft = Pick<MailDraft, "threadId" | "cc" | "bcc" | "subject">;

/** A reply's subject as the conversation gives it (as mail.draft makes it): "Re: " once. */
export const replySubject = (conversation: string) =>
  /^re:/i.test(conversation) ? conversation : `Re: ${conversation}`;

/**
 * Whether Bcc and Subject start folded away: only on a reply whose Bcc is empty and whose Subject
 * is the conversation's reply subject (`conversation`: its subject). Without the conversation to
 * compare with, they show.
 */
export function foldsExtras(draft: Draft, conversation?: string): boolean {
  return (
    Boolean(draft.threadId) &&
    draft.bcc.length === 0 &&
    conversation !== undefined &&
    draft.subject === replySubject(conversation)
  );
}

/** Whether Cc starts out showing on its own: it has someone on it. It then stays while you edit. */
export function showsCc(draft: Draft, conversation?: string): boolean {
  return !foldsExtras(draft, conversation) || draft.cc.length > 0;
}

/** A draft as the composer has it: each field as it shows, addresses as typed. */
export interface DraftFields {
  from: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
}

/**
 * Whether a draft's Bcc and Subject may stay folded as it changes (Jarvis, another screen): only
 * while its Bcc is empty and its Subject is the conversation's. Once not, they show, and stay.
 */
export const fieldsFold = (d: Pick<DraftFields, "bcc" | "subject">, conversation?: string) =>
  d.bcc.trim() === "" && conversation !== undefined && d.subject === replySubject(conversation);

/**
 * Recipients as a field shows them: "Ana Silva <ana@x.example>, bo@x.example". A name with any
 * mark but . ' - in it is quoted ("Silva, Ana"), so it splits back as one.
 */
export const showAddresses = (xs: MailAddress[]) =>
  xs
    .map((a) => {
      if (!a.name) return a.address;
      const name = /^[\p{L}\p{N} .'-]*$/u.test(a.name) ? a.name : `"${a.name}"`;
      return `${name} <${a.address}>`;
    })
    .join(", ");

/**
 * A field's recipients: split at commas and semicolons outside quotes and <…>, and at every new
 * line. A run of addresses with only spaces between them (a pasted column) splits too. A quote
 * left open keeps the rest of its line as one, saved as typed and named at Send.
 */
export function splitAddresses(s: string): string[] {
  const out: string[] = [];
  let piece = "";
  let quoted = false;
  let angled = false;
  for (const ch of s) {
    if (ch === "\n" || (!quoted && !angled && (ch === "," || ch === ";"))) {
      out.push(piece);
      piece = "";
      if (ch === "\n") quoted = angled = false;
      continue;
    }
    if (ch === '"' && !angled) quoted = !quoted;
    else if (!quoted && (ch === "<" || ch === ">")) angled = ch === "<";
    piece += ch;
  }
  out.push(piece);
  return out.flatMap(spaced).filter(Boolean);
}

/** One piece, or each word of a run of bare addresses ("a@x.example b@x.example"). */
function spaced(piece: string): string[] {
  const words = piece.trim().split(/\s+/);
  return words.length > 1 && words.every((w) => w.includes("@") && !/[<>"]/.test(w))
    ? words
    : [piece.trim()];
}

export const fieldsOf = (d: MailDraft): DraftFields => ({
  from: d.account,
  to: showAddresses(d.to),
  cc: showAddresses(d.cc),
  bcc: showAddresses(d.bcc),
  subject: d.subject,
  text: d.text,
});

/**
 * What saves a draft (mail.draft_update) on the version it was made on. `account` only when
 * another From was picked: one named must still be connected.
 */
export const draftInput = (id: string, d: DraftFields, baseVersion: number, account?: string) => ({
  id,
  baseVersion,
  to: splitAddresses(d.to),
  cc: splitAddresses(d.cc),
  bcc: splitAddresses(d.bcc),
  subject: d.subject,
  text: d.text,
  ...(account ? { account } : {}),
});

/**
 * Yours and a copy saved elsewhere since `base`: a field you changed keeps your change, one you
 * didn't takes theirs. In the message, the lines only they wrote are kept too, after yours.
 */
export function mergeDraft(base: DraftFields, mine: DraftFields, theirs: DraftFields): DraftFields {
  const pick = <K extends keyof DraftFields>(k: K) => (mine[k] !== base[k] ? mine[k] : theirs[k]);
  return {
    from: pick("from"),
    to: pick("to"),
    cc: pick("cc"),
    bcc: pick("bcc"),
    subject: pick("subject"),
    text: mergeText(base.text, mine.text, theirs.text),
  };
}
