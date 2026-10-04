// Deciding an approval, from the inbox or a conversation. One decision at a time per approval:
// its buttons are off while it's on its way, and once it's decided they stay gone, even before
// the lists catch up. Hearth itself runs an approval at most once whatever arrives (D58).
import { createSignal } from "solid-js";
import { decideApproval } from "./api.ts";
import { affectedByChange } from "./invalidate.ts";
import { live, toast } from "./live.ts";

const [inFlight, setInFlight] = createSignal<ReadonlySet<string>>(new Set());
const [decided, setDecided] = createSignal<ReadonlySet<string>>(new Set());

const add = (set: ReadonlySet<string>, id: string) => new Set([...set, id]);
const drop = (set: ReadonlySet<string>, id: string) => new Set([...set].filter((x) => x !== id));

/** A decision on this approval is on its way. */
export const deciding = (approvalId: string) => inFlight().has(approvalId);

/** This approval was decided here (or turned out to be decided already). */
export const isDecided = (approvalId: string) => decided().has(approvalId);

export async function decide(approvalId: string, decision: "approve" | "deny") {
  if (deciding(approvalId) || isDecided(approvalId)) return;
  setInFlight((s) => add(s, approvalId));
  try {
    const r = await decideApproval(approvalId, decision).catch((err: Error) => err);
    if (r instanceof Error) {
      // It may still have gone through; asking again is safe, since it runs at most once.
      toast.show(r.message, "error");
      return;
    }
    if (r.status === "ok") {
      setDecided((s) => add(s, approvalId));
      toast.show(decision === "approve" ? "Approved and done." : "Denied.");
    } else if (r.status === "error") {
      // Decided elsewhere, ran out, or approved and then failed: it's no longer waiting either
      // way. Only Hearth being out of reach leaves it to decide again.
      if (r.code !== "unavailable") setDecided((s) => add(s, approvalId));
      toast.show(r.message, r.message.startsWith("This was already") ? "info" : "error");
    } else if (r.status === "denied") toast.show(r.reason, "error");
  } finally {
    setInFlight((s) => drop(s, approvalId));
    // What the approved action changed arrives as its own live events.
    live.refresh(live.connected() ? affectedByChange("approval.decide") : null);
  }
}

/** An approval's state in a few words, for a card that's no longer waiting. */
export function approvalStateText(status: string): string {
  return (
    {
      executing: "Being done…",
      executed: "Approved and done",
      denied: "Denied",
      failed: "Approved, but it failed",
      expired: "Ran out before you decided",
    }[status] ?? `Approval ${status}`
  );
}
