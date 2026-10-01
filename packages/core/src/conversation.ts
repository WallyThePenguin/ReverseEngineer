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
  | { type: "notice"; text: string; tone: "info" | "error"; turnId: string | null; idx: number };

export interface ConversationView {
  items: ConversationItem[];
  /** Turns started but not finished: Jarvis is working. */
  activeTurns: string[];
}

const iso = (v: string | Date) => (typeof v === "string" ? v : v.toISOString());

export function foldConversation(log: LogRecord[]): ConversationView {
  const items: ConversationItem[] = [];
  const tools = new Map<string, Extract<ConversationItem, { type: "tool" }>>();
  const active = new Set<string>();
  for (const r of [...log].sort((a, b) => a.idx - b.idx)) {
    const p = r.payload;
    switch (r.kind) {
      case "user_message":
        items.push({
          type: "message",
          role: "you",
          text: String(p.text ?? ""),
          at: iso(r.at),
          turnId: r.turnId,
          idx: r.idx,
        });
        break;
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
        if (r.turnId) active.add(r.turnId);
        break;
      case "turn_finished":
        if (r.turnId) active.delete(r.turnId);
        break;
      case "error":
        if (r.turnId) active.delete(r.turnId);
        items.push({
          type: "notice",
          text: String(p.message ?? "Something went wrong"),
          tone: "error",
          turnId: r.turnId,
          idx: r.idx,
        });
        break;
      case "notice":
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
  return { items, activeTurns: [...active] };
}
