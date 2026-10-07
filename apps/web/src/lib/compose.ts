// What a draft shows when it opens. A reply folds Bcc and Subject behind "More", since they come
// from the conversation, but never a Bcc with anyone on it, nor a Subject that isn't just the
// conversation's: nothing an email carries is out of sight when you press Send, whoever filled
// the draft in (Jarvis drafts replies too, and can set the subject).

import type { MailDraft } from "./types.ts";

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
