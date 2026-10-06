// The counts on Today's badge (the sidebar and the phone's tab bar) and on its Updates tab: each
// counts what that place shows, so a number never points at something you can't find there.

import { askedToSend } from "./needsYou.ts";
import { inboxInput, useAction, usePendingApprovals } from "./query.ts";
import { jarvisDrafts } from "./today.ts";
import type { InboxRow, MailDraft } from "./types.ts";

/**
 * What Today shows needing you: the approvals waiting for your yes and the drafts Jarvis has ready
 * to send (one it already asked to send counts once, as its approval).
 */
export function useWaiting() {
  const approvals = usePendingApprovals();
  const drafts = useAction<MailDraft[]>("mail.drafts");
  return () => {
    const asked = askedToSend(approvals.data);
    const ready = jarvisDrafts(drafts.data).filter((d) => !asked.has(d.id));
    return (approvals.data?.length ?? 0) + ready.length;
  };
}

/** What Updates shows that you haven't seen; an approval's card is counted on Today, as its yes. */
export function useUnseenUpdates() {
  const inbox = useAction<InboxRow[]>("inbox.list", () => inboxInput("live", "signal"));
  const approvals = usePendingApprovals();
  return () => {
    const pending = new Set((approvals.data ?? []).map((a) => a.id));
    return (inbox.data ?? []).filter(
      (r) =>
        r.notification.state === "unseen" &&
        !(r.notification.approvalId && pending.has(r.notification.approvalId)),
    ).length;
  };
}
