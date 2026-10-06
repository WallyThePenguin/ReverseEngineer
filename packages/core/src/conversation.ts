// A conversation is an append-only log; this pure fold turns it into what the UI shows, so a
// live stream and a reload look the same (Macro's agent_fold pattern).

export interface LogRecord {
  idx: number;
  at: string | Date;
  turnId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export type ConversationItem =
  | {
      type: "message";
      role: "you" | "jarvis";
      text: string;
      at: string;
      turnId: string | null;
      idx: number;
      /** Who wrote it when it isn't you: someone in Slack, by the name Hearth knows (D62). */
      author?: string;
      /** Where you wrote it, when not in Hearth: your DM with Jarvis in Slack (D62). */
      via?: "slack";
    }
  | {
      type: "tool";
      name: string;
      input: unknown;
      output: string | null;
      isError: boolean;
      status: "running" | "done" | "pending_approval";
      approvalId: string | null;
      turnId: string | null;
      idx: number;
    }
  | {
      type: "notice";
      text: string;
      tone: "info" | "error";
      turnId: string | null;
      idx: number;
      /** A failed turn that can be run again from here: the latest one, until anything else happens (D54). */
      retry?: boolean;
    };

export interface ConversationView {
  items: ConversationItem[];
  /** Turns started but not finished: Jarvis is working. */
  activeTurns: string[];
  /** When you last said something Jarvis hasn't started on yet, if so (D54). */
  waitingSince: string | null;
}

const iso = (v: string | Date) => (typeof v === "string" ? v : v.toISOString());

export function foldConversation(log: LogRecord[]): ConversationView {
  const items: ConversationItem[] = [];
  const tools = new Map<string, Extract<ConversationItem, { type: "tool" }>>();
  const active = new Set<string>();
  let waitingSince: string | null = null;
  const settle = () => {
    for (const item of items) if (item.type === "notice") item.retry = false;
  };
  for (const r of [...log].sort((a, b) => a.idx - b.idx)) {
    const p = r.payload;
    // What you said is picked up when a turn starts after it, or let go when a turn that never
    // started is stopped or expires. A turn already running doesn't count: yours waits behind it.
    const running = r.turnId !== null && active.has(r.turnId);
    if (r.kind === "turn_started" || ((r.kind === "error" || r.kind === "notice") && !running))
      waitingSince = null;
    switch (r.kind) {
      case "user_message": {
        settle();
        // A routine's prompt is logged by its own turn; only what you send waits for one.
        if (r.turnId === null) waitingSince = iso(r.at);
        // In a Slack member's conversation the line is theirs, not yours (D62).
        const member = String(p.by ?? "").startsWith("member:");
        const name = typeof p.name === "string" && p.name ? p.name : "Someone in Slack";
        items.push({
          type: "message",
          role: "you",
          text: String(p.text ?? ""),
          at: iso(r.at),
          turnId: r.turnId,
          idx: r.idx,
          ...(member ? { author: name } : {}),
          ...(p.via === "slack" ? { via: "slack" as const } : {}),
        });
        break;
      }
      case "assistant_message":
        items.push({
          type: "message",
          role: "jarvis",
          text: String(p.text ?? ""),
          at: iso(r.at),
          turnId: r.turnId,
          idx: r.idx,
        });
        break;
      case "tool_call": {
        const item = {
          type: "tool" as const,
          name: String(p.name ?? ""),
          input: p.input ?? null,
          output: null,
          isError: false,
          status: "running" as const,
          approvalId: null,
          turnId: r.turnId,
          idx: r.idx,
        };
        tools.set(String(p.callId ?? r.idx), item);
        items.push(item);
        break;
      }
      case "tool_result":
      case "approval_pending": {
        const t = tools.get(String(p.callId ?? ""));
        if (!t) break;
        t.output = String(p.output ?? "");
        t.isError = Boolean(p.isError);
        t.status = r.kind === "approval_pending" ? "pending_approval" : "done";
        t.approvalId = r.kind === "approval_pending" ? String(p.approvalId ?? "") : null;
        break;
      }
      case "turn_started":
        settle();
        if (r.turnId) active.add(r.turnId);
        break;
      case "turn_finished":
        if (r.turnId) active.delete(r.turnId);
        break;
      case "error":
        if (r.turnId) active.delete(r.turnId);
        settle();
        items.push({
          type: "notice",
          text: String(p.message ?? "Something went wrong"),
          tone: "error",
          turnId: r.turnId,
          idx: r.idx,
          retry: p.retry === true && r.turnId !== null,
        });
        break;
      case "notice":
        // You pressed Retry: that turn now waits for Jarvis, like something you said.
        if (p.retrying === true) {
          settle();
          waitingSince = iso(r.at);
        }
        items.push({
          type: "notice",
          text: String(p.text ?? ""),
          tone: "info",
          turnId: r.turnId,
          idx: r.idx,
        });
        break;
    }
  }
  return { items, activeTurns: [...active], waitingSince };
}
