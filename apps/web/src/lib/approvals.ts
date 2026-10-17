// Deciding an approval, from the inbox or a conversation. One decision at a time per approval:
// its buttons are off while it's on its way, and once it's decided they stay gone, even before
// the lists catch up, with what became of it. Hearth itself runs an approval at most once
// whatever arrives (D58).
import { createSignal } from "solid-js";
import { decideApproval } from "./api.ts";
import { affectedByChange } from "./invalidate.ts";
import { KEPT_HERE, sendsKept } from "./keptDrafts.ts";
import { live, type Toast, toast } from "./live.ts";
import type { Approval, StandingRule } from "./types.ts";

/**
 * An approval's state as Hearth names it, or "gone" where all that's known is that it no longer
 * waits for you.
 */
export type ApprovalState =
  | "pending"
  | "executing"
  | "executed"
  | "denied"
  | "failed"
  | "expired"
  | "gone";

const [inFlight, setInFlight] = createSignal<ReadonlySet<string>>(new Set());
const [decided, setDecided] = createSignal<ReadonlyMap<string, ApprovalState>>(new Map());

const add = (set: ReadonlySet<string>, id: string) => new Set([...set, id]);
const drop = (set: ReadonlySet<string>, id: string) => new Set([...set].filter((x) => x !== id));
const settle = (id: string, state: ApprovalState) =>
  setDecided((m) => new Map([...m, [id, state]]));

/** A decision on this approval is on its way. */
export const deciding = (approvalId: string) => inFlight().has(approvalId);

/** This approval was decided here (or turned out to be decided already). */
export const isDecided = (approvalId: string) => decided().has(approvalId);

/** What became of an approval decided here, or null if it wasn't. */
export const decidedAs = (approvalId: string): ApprovalState | null =>
  decided().get(approvalId) ?? null;

/** Still waiting for your yes or no: pending, and not decided here a moment ago. */
export const isWaiting = (approvalId: string, status: string | null | undefined) =>
  status === "pending" && !isDecided(approvalId);

/**
 * What Hearth's answer to a decision it couldn't take says became of the approval, in the
 * kernel's own words (approvals.ts). Anything else after a yes means it was approved but nothing
 * came of it; after a no, only that it's gone.
 */
const TAKEN: [string, ApprovalState][] = [
  ["This was already approved and done", "executed"],
  ["This was already denied", "denied"],
  ["This was already approved, and it failed", "failed"],
  ["This is already being done", "executing"],
  ["This approval ran out", "expired"],
];
export function settledAs(
  decision: "approve" | "deny",
  r: { code: string; message: string },
): ApprovalState {
  if (r.code === "not_found") return "gone";
  const known = TAKEN.find(([said]) => r.message.startsWith(said));
  if (known) return known[1];
  return decision === "approve" ? "failed" : "gone";
}

/**
 * How a decision sent from here went: done as asked; turned away because something changed first
 * (someone decided it elsewhere, it ran out, or what it would do changed since you saw it, as a
 * draft edited meanwhile); or not done (Hearth out of reach, or it failed).
 */
export type Decided = "done" | "changed" | "failed";

/** Hearth's answers that something changed under the decision, rather than that it failed. */
const CHANGED = new Set(["conflict", "not_found"]);

/** How a decision went, with what Hearth said when it wasn't done as asked. */
export interface Decision {
  outcome: Decided;
  /** Hearth's own words for why it wasn't done ("The draft changed since…"), if it said any. */
  message: string | null;
  /** Hearth didn't answer: it may still have gone through. */
  unanswered?: true;
  /** Always allow's rule as Hearth wrote it, when the yes went through with one. */
  kept?: Kept;
}

/** What a yes with Always allow answers: its rule, and whether an earlier press had saved it. */
export interface Kept {
  rule: Pick<StandingRule, "action" | "target" | "note">;
  already?: true;
}

const keptOf = (result: unknown): Kept | null => {
  const k = result as Partial<Kept> | null;
  return typeof k?.rule?.note === "string" ? (k as Kept) : null;
};

/** What a yes says once it's done, in the approval's own words: "Sent to Dana Ruiz · View". */
export interface Said {
  text: string;
  action?: Toast["action"];
}

/** Sends your yes or no, and says how it went in a toast. */
export async function decide(
  approvalId: string,
  decision: "approve" | "deny",
  said?: Said,
): Promise<Decided> {
  // A second press while the first is on its way (or just after) does nothing, quietly.
  if (deciding(approvalId) || isDecided(approvalId)) return "changed";
  const d = await decideQuietly(approvalId, decision);
  if (d.outcome === "done") {
    if (decision === "deny") toast.show("Denied.");
    else toast.show(said?.text ?? "Approved and done.", "ok", said?.action);
  } else if (d.message)
    toast.show(d.message, d.message.startsWith("This was already") ? "info" : "error");
  return d.outcome;
}

/** Always allow's words for a waiting request, if it came from a conversation you started (D70). */
export const alwaysAllowWords = (a: Approval | undefined): string | null =>
  a?.origin === "owner" && a.requestedBy === "jarvis" ? (a.alwaysAllow?.says ?? null) : null;

/**
 * Always allow (D70): says yes to the card and writes its rule, in its one place or to its one
 * person, together. Hearth writes the rule only when the yes goes through, so whatever stops the
 * yes (decided elsewhere, ran out, what it sends changed, a turn that read an email asked for the
 * same thing) leaves no rule, and you're told so. What it says comes from the rule Hearth wrote.
 */
export async function alwaysAllow(approvalId: string): Promise<Decided> {
  if (deciding(approvalId) || isDecided(approvalId)) return "changed";
  const d = await decideQuietly(approvalId, "approve", true);
  if (d.kept)
    toast.show(
      `${d.kept.already ? "Already done" : "Done"}. From now on, ${d.kept.rule.note} goes without asking.`,
      "ok",
    );
  else if (d.outcome === "done") toast.show("Approved and done, but no rule was saved.", "error");
  else if (d.unanswered) toast.show(d.message ?? "Hearth didn't answer.", "error");
  else
    toast.show(
      `${d.message ?? "It didn't go through."} No rule was saved.`,
      d.message?.startsWith("This was already") ? "info" : "error",
    );
  return d.outcome;
}

/** What a rule for any channel or person reaches, beside the ones for just one (D70). */
const ANY_TARGET: Record<string, string> = {
  "slack.post_in_channel": "any channel",
  "slack.dm": "anyone",
};

/** A standing rule in Settings' words: "Always allow posting in #eng", or its note and reach. */
export function ruleWords(r: Pick<StandingRule, "action" | "target" | "note">): string {
  if (r.target) return `Always allow ${r.note}`;
  const any = ANY_TARGET[r.action];
  return [r.note, any].filter(Boolean).join(" · ");
}

/**
 * Sends your yes or no and says nothing: the caller says how it went. Today's "Approve all" sends
 * several and reports them together, each with Hearth's reason when it wasn't done.
 */
export async function decideQuietly(
  approvalId: string,
  decision: "approve" | "deny",
  /** Always allow: the yes also writes the card's rule (D70). */
  alwaysAllow = false,
): Promise<Decision> {
  // On its way already, or decided a moment ago: not the one you were looking at any more.
  if (deciding(approvalId) || isDecided(approvalId))
    return { outcome: "changed", message: "It was decided a moment ago." };
  setInFlight((s) => add(s, approvalId));
  try {
    // A send of a draft with changes on this device that Hearth doesn't have yet waits for them.
    if (decision === "approve" && (await sendsKept(approvalId)))
      return { outcome: "failed", message: KEPT_HERE };
    const r = await decideApproval(approvalId, decision, alwaysAllow).catch((err: Error) => err);
    // It may still have gone through; asking again is safe, since it runs at most once.
    if (r instanceof Error) return { outcome: "failed", message: r.message, unanswered: true };
    if (r.status === "ok") {
      settle(approvalId, decision === "approve" ? "executed" : "denied");
      const kept = alwaysAllow ? keptOf(r.result) : null;
      return { outcome: "done", message: null, ...(kept ? { kept } : {}) };
    }
    if (r.status === "error") {
      // Decided elsewhere, ran out, or approved and then failed: it's no longer waiting either
      // way. Only Hearth being out of reach leaves it to decide again.
      if (r.code !== "unavailable") settle(approvalId, settledAs(decision, r));
      return { outcome: CHANGED.has(r.code) ? "changed" : "failed", message: r.message };
    }
    return { outcome: "failed", message: r.status === "denied" ? r.reason : null };
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
      failed: "Approved, but it didn't go through",
      expired: "Ran out before you decided",
      gone: "No longer waiting",
    }[status] ?? `Approval ${status}`
  );
}
