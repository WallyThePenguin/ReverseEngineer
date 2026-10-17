// The rows of a conversation that aren't messages: what Jarvis used, said as a sentence with its
// raw input behind it, and any yes it asked for, as the same card the inbox shows (D58); and why
// it asks more once it has read outside content.

import type { ConversationItem } from "@hearth/core";
import { createMemo, createSignal, Show } from "solid-js";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { Badge } from "../components/ui.tsx";
import { alwaysAllowWords, isWaiting } from "../lib/approvals.ts";
import { summaryParts } from "../lib/inbox.ts";
import { PENDING_LIMIT, usePendingApprovals } from "../lib/query.ts";
import { toolSentence } from "../lib/toolNames.ts";

/** Why Jarvis asks more in this conversation: it read outside content here (D58). */
export function OutsideNote(props: { source: string | null | undefined }) {
  return (
    <p
      class="flex items-center gap-2 text-xs text-muted"
      title="Text from outside Nook could try to steer Pip, so for the rest of this conversation it checks with you before acting outside it. A new conversation starts fresh."
    >
      <Badge tone="warn">Read {props.source || "outside content"}</Badge>
      <span>Pip checks with you before acting here. A new conversation starts fresh.</span>
    </p>
  );
}

/**
 * A yes Jarvis asked for here. The conversation logs only that it asked, so whether it still waits
 * comes from the approvals waiting for you (the sidebar's count reads the same): while it's among
 * them it's the whole card, with its text and its buttons, and after that a line of what became of
 * it, its text still in the tool's details.
 */
function Asked(props: { approvalId: string; summary: string | null }) {
  const pending = usePendingApprovals();
  const parts = () => summaryParts(props.summary);
  const status = createMemo<string | null>((was) => {
    const list = pending.data;
    if (!list) return null;
    // A full page may have left it out, so it may still be waiting: deciding it then is safe.
    if (list.length >= PENDING_LIMIT || list.some((a) => a.id === props.approvalId))
      return "pending";
    // Asked a moment ago, the list may still be catching up with it.
    return pending.isFetching ? was : "gone";
  }, null);
  return (
    <ApprovalCard
      approvalId={props.approvalId}
      what={`Pip asks: ${parts().what ?? "something that needs your yes (see the inbox)"}`}
      text={isWaiting(props.approvalId, status()) ? parts().text : null}
      status={status()}
      always={alwaysAllowWords(pending.data?.find((a) => a.id === props.approvalId))}
      byJarvis
      class="mt-1.5"
    />
  );
}

export function ToolLine(props: { item: Extract<ConversationItem, { type: "tool" }> }) {
  const [open, setOpen] = createSignal(false);
  const asking = () => props.item.status === "pending_approval" && props.item.approvalId;
  return (
    <div>
      <button
        type="button"
        class="text-xs text-muted hover:text-ink"
        title="Details"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        {toolSentence(props.item.name, props.item.status, props.item.isError)}
      </button>
      {/* Decided here or in the inbox, it runs once whichever you use. */}
      <Show when={asking()}>
        {(approvalId) => <Asked approvalId={approvalId()} summary={props.item.output} />}
      </Show>
      <Show when={open()}>
        <pre class="mt-1 max-h-48 overflow-auto rounded bg-sunk p-2 font-mono text-micro font-normal whitespace-pre-wrap text-muted">
          {JSON.stringify(props.item.input, null, 2)}
          {props.item.output ? `\n→ ${props.item.output}` : ""}
        </pre>
      </Show>
    </div>
  );
}
