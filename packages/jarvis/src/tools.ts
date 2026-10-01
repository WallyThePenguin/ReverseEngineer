// Jarvis's tools are Hearth's actions: the same registry the UI uses, so there are no side
// doors. Every call runs through the kernel as Jarvis, with the turn's trust level.
import { asUntrusted, formatDateTime, type Origin, type Risk } from "@hearth/core";
import { entity } from "@hearth/db";
import { type Caller, isVisibleTo, jarvisCaller, type Kernel, newId } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { BrainTool } from "./brain.ts";

const MAX_OUTPUT = 20_000;

export interface ToolCallRecord {
  action: string;
  risk: Risk;
  status: "ok" | "pending_approval" | "denied" | "error";
}

/** What a turn knows while it runs. Origin can only go down (web content makes it untrusted). */
export interface TurnState {
  turnId: string;
  conversationId: string;
  subjectId: string | null;
  origin: Origin;
  causationId: string | null;
  calls: ToolCallRecord[];
  postedToSubject: boolean;
}

export type LogFn = (
  kind: "tool_call" | "tool_result" | "approval_pending",
  payload: Record<string, unknown>,
) => Promise<void>;

/** JSON for the model, with every time also written as 12-hour Eastern. */
export function toModelJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v instanceof Date) return `${formatDateTime(v)} ET (${v.toISOString()})`;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const text = JSON.stringify(walk(value), null, 1) ?? "null";
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…(truncated)` : text;
}

export function toolName(action: string): string {
  return action.replaceAll(".", "_");
}

export function buildTools(kernel: Kernel, state: TurnState, log: LogFn): BrainTool[] {
  const caller = () =>
    jarvisCaller(state.origin, {
      turnId: state.turnId,
      conversationId: state.conversationId,
      correlationId: state.turnId,
      ...(state.causationId ? { causationId: state.causationId } : {}),
    });

  const tools: BrainTool[] = [];
  for (const def of kernel.registry.allActions()) {
    if (!isVisibleTo(def, "agent") || !(def.input instanceof z.ZodObject)) continue;
    const needsYes = def.risk === "outward" || def.risk === "destructive";
    tools.push({
      name: toolName(def.name),
      description: needsYes
        ? `${def.description} (Waits for the owner's approval.)`
        : def.description,
      input: def.input,
      async run(input) {
        const callId = newId();
        await log("tool_call", { callId, name: def.name, input });
        const res = await kernel.execute(def.name, input, caller());
        state.calls.push({
          action: def.name,
          risk: def.risk,
          status: res.status === "ok" ? "ok" : res.status,
        });
        if (
          res.status === "ok" &&
          def.name === "comment.create" &&
          (input as { parentId?: string }).parentId === state.subjectId
        ) {
          state.postedToSubject = true;
        }
        if (res.status === "pending_approval") {
          await log("approval_pending", {
            callId,
            approvalId: res.approvalId,
            output: res.summary,
          });
          return `Waiting for the owner's approval (approval ${res.approvalId}): ${res.summary}. Carry on with anything else; you'll be told when they decide.`;
        }
        const output =
          res.status === "ok"
            ? toModelJson(res.result)
            : res.status === "denied"
              ? `Not allowed: ${res.reason}`
              : `Error (${res.code}): ${res.message}`;
        await log("tool_result", {
          callId,
          output: output.slice(0, 4000),
          isError: res.status !== "ok",
        });
        return output;
      },
    });
  }

  tools.push({
    name: "record_read",
    description:
      "Read any record (note, task, person, conversation, comment, brief...) as markdown, with its links and backlinks. Use this before acting on a record.",
    input: z.object({ id: z.string().uuid() }),
    async run(input) {
      const { id } = input as { id: string };
      const callId = newId();
      await log("tool_call", { callId, name: "record.read", input });
      const text = await describeRecord(kernel, id);
      state.calls.push({ action: "record.read", risk: "read", status: text ? "ok" : "error" });
      await log("tool_result", {
        callId,
        output: (text ?? "Not found").slice(0, 4000),
        isError: !text,
      });
      return text ?? "No record with that id.";
    },
  });
  return tools;
}

/** A record as Jarvis reads it: its module's description, plus links both ways. */
export async function describeRecord(
  kernel: Kernel,
  id: string,
  caller: Caller = jarvisCaller("agent"),
): Promise<string | null> {
  const [row] = await kernel.db.select().from(entity).where(eq(entity.id, id));
  if (!row) return null;
  const ctx = { db: kernel.db, now: kernel.clock.now() };
  const describe = kernel.registry.describer(row.type);
  let text = describe ? await describe(id, ctx) : null;
  if (!text) return null;
  const links = await kernel.execute<{
    outgoing: { otherId: string; otherType: string; otherTitle: string }[];
    incoming: { otherId: string; otherType: string; otherTitle: string }[];
  }>("entity.links", { id }, caller);
  if (links.status === "ok") {
    const fmt = (l: { otherId: string; otherType: string; otherTitle: string }) =>
      `- ${l.otherType} "${l.otherTitle}" (${l.otherId})`;
    if (links.result.outgoing.length)
      text += `\n\n## Links to\n${links.result.outgoing.map(fmt).join("\n")}`;
    if (links.result.incoming.length)
      text += `\n\n## Linked from\n${links.result.incoming.map(fmt).join("\n")}`;
  }
  const fromOutside = row.createdBy.startsWith("integration:") || row.createdBy.startsWith("mcp:");
  return fromOutside ? asUntrusted(text, row.createdBy) : text;
}
