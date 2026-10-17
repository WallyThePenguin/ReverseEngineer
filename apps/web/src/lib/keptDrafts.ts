// Drafts typed on this device that never reached Hearth. A composer keeps what Hearth doesn't have
// yet on the device (wholeSave.ts), and one closed while its saves were failing (a weak signal,
// Hearth restarting) leaves that copy behind. Each is sent once Hearth can be reached: as the app
// starts, when the connection comes back, and after a restore. It's merged onto Hearth's newer
// version as the composer would merge it (compose.ts), then dropped. Until then, Ready to send and
// a send's approval don't send that draft (KEPT_HERE), so nothing goes out without what was typed
// here.

import { createEffect, createSignal } from "solid-js";
import { ApiError, action } from "./api.ts";
import { type DraftFields, draftInput, fieldsOf, mergeDraft } from "./compose.ts";
import { withClosedCopies } from "./copyLocks.ts";
import { keptIds, takeOverUnsaved, unsavedCopies } from "./docStore.ts";
import { queryClient } from "./live.ts";
import type { Approval, MailDraft } from "./types.ts";

export const KEPT_HERE =
  "This device has changes to this draft that haven't reached Hearth. Edit to see them.";
/** Saves turned down in a row for the draft changing meanwhile, before it waits for next time. */
const MERGES = 3;
const EMPTY: DraftFields = { from: null, to: "", cc: "", bcc: "", subject: "", text: "" };

/** Bumped as kept drafts are sent, so whatever shows one waiting looks again. */
const [round, setRound] = createSignal(0);

/** Whether this device keeps changes to draft `id` that Hearth doesn't have yet. */
export const keptHere = async (id: string) => (await unsavedCopies(`draft:${id}`)).length > 0;

/**
 * Whether this device keeps changes to the draft `id()` names (none: false). Looked at again as
 * `also()` changes, and as kept drafts are sent.
 */
export function createKept(id: () => string | null | undefined, also?: () => unknown) {
  const [kept, setKept] = createSignal(false);
  let asked = 0;
  createEffect(() => {
    const d = id();
    also?.();
    round();
    const n = ++asked;
    if (!d) {
      setKept(false);
      return;
    }
    void keptHere(d).then((k) => n === asked && setKept(k));
  });
  return kept;
}

/**
 * Whether approval `approvalId`, as the approvals read here have it, sends a draft this device
 * keeps changes to.
 */
export async function sendsKept(approvalId: string): Promise<boolean> {
  const ids = await keptIds("draft:").catch((): string[] => []);
  if (!ids.length) return false;
  const a = queryClient
    .getQueriesData<Approval[]>({ queryKey: ["approval.list"] })
    .flatMap(([, list]) => list ?? [])
    .find((x) => x.id === approvalId);
  const draft = a?.action === "mail.send" ? (a.input as { id?: unknown } | null)?.id : null;
  return typeof draft === "string" && ids.includes(draft);
}

let sending: Promise<void> = Promise.resolve();

/** Sends every draft kept here whose composer has closed, one after another. Never fails. */
export function sendKeptDrafts(): Promise<void> {
  sending = sending.then(async () => {
    for (const id of await keptIds("draft:").catch(() => [])) await sendKept(id).catch(() => {});
    setRound((n) => n + 1);
  });
  return sending;
}

/**
 * One draft's copies from closed composers, merged onto Hearth's newest version and saved on it. If
 * Hearth turns the save down because the draft changed meanwhile, it's merged again. If Hearth no
 * longer has the draft (sent, or in the trash) or can't be reached, the copies stay for the
 * composer to take in.
 */
async function sendKept(id: string): Promise<void> {
  await withClosedCopies<DraftFields, void>(`draft:${id}`, async (copies) => {
    if (!copies.length) return;
    for (let i = 0; i < MERGES; i++) {
      const theirs = (await action<MailDraft[]>("mail.drafts", { id }))[0];
      if (!theirs) return;
      let data = fieldsOf(theirs);
      for (const k of copies) data = mergeDraft(k.base ?? EMPTY, k.data, data);
      const account = data.from && data.from !== theirs.account ? data.from : undefined;
      try {
        await action("mail.draft_update", draftInput(id, data, theirs.version, account));
      } catch (err) {
        if (err instanceof ApiError && err.code === "conflict") continue;
        throw err;
      }
      return takeOverUnsaved(null, copies);
    }
  });
}

/** Sends kept drafts now and whenever the connection comes back. Returns what stops that. */
export function keepSendingDrafts(): () => void {
  const online = () => void sendKeptDrafts();
  void sendKeptDrafts();
  window.addEventListener("online", online);
  return () => window.removeEventListener("online", online);
}
