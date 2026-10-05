// The rows of a conversation that aren't messages: what Jarvis used (and any yes it waits for),
// and why it asks more once it has read outside content (D58).

import type { ConversationItem } from "@hearth/core";
import { createSignal, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { decide, deciding, isDecided } from "../lib/approvals.ts";

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
  const name = () => props.item.name.replace(/^mcp__hearth__/, "").replaceAll("_", " ");
  return (
    <div class="text-xs text-muted">
      <button type="button" class="hover:text-ink" onClick={() => setOpen(!open())}>
        {props.item.status === "running" ? "Using" : "Used"} {name()}
        {props.item.isError ? " (failed)" : ""}
      </button>
      <Show
        when={
          props.item.status === "pending_approval" &&
          props.item.approvalId &&
          !isDecided(props.item.approvalId)
        }
      >
        <div class="mt-1 flex items-center gap-2 rounded-md bg-accent-soft px-2 py-1.5 text-ink">
          <span class="flex-1 whitespace-pre-wrap">
            Waiting for your yes: {props.item.output || "see the Inbox."}
          </span>
          <Button
            kind="primary"
            small
            disabled={deciding(props.item.approvalId!)}
            onClick={() => decide(props.item.approvalId!, "approve")}
          >
            Approve
          </Button>
          <Button
            kind="danger"
            small
            disabled={deciding(props.item.approvalId!)}
            onClick={() => decide(props.item.approvalId!, "deny")}
          >
            Deny
          </Button>
        </div>
      </Show>
      <Show when={open()}>
        <pre class="mt-1 max-h-48 overflow-auto rounded bg-sunk p-2 font-mono text-[11px] whitespace-pre-wrap">
          {JSON.stringify(props.item.input, null, 2)}
          {props.item.output ? `\n→ ${props.item.output}` : ""}
        </pre>
      </Show>
    </div>
  );
}
