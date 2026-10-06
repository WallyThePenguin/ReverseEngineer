// What a draft shows when it opens. A reply folds Bcc and Subject behind "More", since they come
// from the conversation, but never a Bcc with anyone on it: nobody an email goes to is out of
// sight when you press Send, whoever filled the draft in (Jarvis drafts replies too).

import type { MailDraft } from "./types.ts";

type Draft = Pick<MailDraft, "threadId" | "cc" | "bcc">;

/** Whether Bcc and Subject start folded away: only on a reply whose Bcc is empty. */
export function foldsExtras(draft: Draft): boolean {
  return Boolean(draft.threadId) && draft.bcc.length === 0;
}

/** Whether Cc starts out showing on its own: it has someone on it. It then stays while you edit. */
export function showsCc(draft: Draft): boolean {
  return !foldsExtras(draft) || draft.cc.length > 0;
}
