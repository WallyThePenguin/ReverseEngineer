// The rows of a conversation that aren't messages: what Jarvis used, said as a sentence with its
// raw input behind it, and any yes it waits for, as the same card the inbox shows (D58); and why
// it asks more once it has read outside content.

import type { ConversationItem } from "@hearth/core";
import { createSignal, Show } from "solid-js";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { Badge } from "../components/ui.tsx";
import { summaryParts } from "../lib/inbox.ts";
import { toolSentence } from "../lib/toolNames.ts";

/** Why Jarvis asks more in this conversation: it read outside content here (D58). */
export function OutsideNote(props: { source: string | null | undefined }) {
  return (
    <p
      class="flex items-center gap-2 text-xs text-muted"
      title="Text from outside Hearth could try to steer Jarvis, so for the rest of this conversation it checks with you before acting outside it. A new conversation starts fresh."
    >
      <Badge tone="warn">Read {props.source || "outside content"}</Badge>
      <span>Jarvis checks with you before acting here. A new conversation starts fresh.</span>
    </p>
  );
}

export function ToolLine(props: { item: Extract<ConversationItem, { type: "tool" }> }) {
  const [open, setOpen] = createSignal(false);
  const asking = () => props.item.status === "pending_approval" && props.item.approvalId;
  const parts = () => summaryParts(props.item.output);
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
      {/* Waiting for your yes: decided here or in the inbox, it runs once whichever you use. */}
      <Show when={asking()}>
        {(approvalId) => (
          <ApprovalCard
            approvalId={approvalId()}
            what={`Jarvis asks: ${parts().what ?? "something that needs your yes (see the inbox)"}`}
            text={parts().text}
            status="pending"
            byJarvis
            class="mt-1.5"
          />
        )}
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
