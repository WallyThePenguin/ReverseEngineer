// Jarvis's tools are Hearth's actions: the same registry the UI uses, so there are no side
// doors. Every call runs through the kernel as Jarvis, with the turn's trust level.
import { asUntrusted, formatDateTime, type Origin, type Risk, type SiteRules } from "@hearth/core";
import { entity } from "@hearth/db";
import {
  type ActionDef,
  type Caller,
  holdsOutside,
  isOutsideRecord,
  isVisibleTo,
  jarvisCaller,
  type Kernel,
  type ModelImage,
  newId,
  withoutGiven,
} from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { BrainTool } from "./brain.ts";
import { readFrom } from "./taint.ts";
import { vouchFor } from "./trust.ts";

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
  /** Web addresses that appeared in outside content this turn (D25). */
  seenUrls: Set<string>;
  /** Sites opened before the turn read outside content (D30). */
  vouchedHosts?: Set<string>;
  sites: SiteRules;
  /** What first made it untrusted (a tool or record type), kept on the conversation (D58). */
  taintedBy?: string;
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

/** Takes the pictures (modelImages) out of an action's result, so they go to the model as images. */
function splitImages(value: unknown): { result: unknown; images: ModelImage[] } {
  if (!value || typeof value !== "object" || !("modelImages" in value))
    return { result: value, images: [] };
  const { modelImages, ...result } = value as { modelImages: ModelImage[] };
  return { result, images: modelImages };
}

export function toolName(action: string): string {
  return action.replaceAll(".", "_");
}

export function buildTools(kernel: Kernel, state: TurnState, log: LogFn): BrainTool[] {
  const caller = (): Caller => ({
    ...jarvisCaller(state.origin, {
      turnId: state.turnId,
      conversationId: state.conversationId,
      correlationId: state.turnId,
      ...(state.causationId ? { causationId: state.causationId } : {}),
    }),
    trust: {
      seenUrls: state.seenUrls,
      ...(state.vouchedHosts ? { vouchedHosts: state.vouchedHosts } : {}),
      sites: state.sites,
    },
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
        // Hearth fills the snapshot in; what the model put there is never what's shown.
        input = withoutGiven(def, input);
        await log("tool_call", { callId, name: def.name, input });
        // The kernel checks what this opens or acts on against what the turn has read (D25,
        // D30), pins it to its page and captures what it will send (D58).
        const trustedBefore = state.origin !== "untrusted";
        const url = trustedBefore ? opensUrl(def, input) : null;
        const res = await kernel.execute(def.name, input, caller());
        state.calls.push({
          action: def.name,
          risk: def.risk,
          status: res.status === "ok" ? "ok" : res.status,
        });
        // A site opened while the turn was still trusted can be acted on after it reads (D30).
        if (res.status === "ok" && url) vouchFor(state, url);
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
        const { result, images } =
          res.status === "ok" ? splitImages(res.result) : { result: null, images: [] };
        let output =
          res.status === "ok"
            ? toModelJson(result)
            : res.status === "denied"
              ? `Not allowed: ${res.reason}`
              : `Error (${res.code}): ${res.message}`;
        const outside =
          def.external || (res.status === "ok" && (await mentionsOutside(kernel, result)));
        if (outside && res.status !== "denied") {
          // Outside content, errors included (they can quote the page): everything after this in
          // the turn is untrusted (D25).
          readFrom(state, def.name, output, result);
          output = asUntrusted(output, def.name);
        }
        await log("tool_result", {
          callId,
          output: output.slice(0, 4000),
          isError: res.status !== "ok",
        });
        return images.length > 0 ? { text: output, images } : output;
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
      const record = await readRecord(kernel, id);
      const text = record?.text ?? null;
      if (record?.fromOutside) readFrom(state, record.source, record.text);
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

/** The address a call would open, read before it runs (a link reference is gone after). */
function opensUrl(def: ActionDef, input: unknown): string | null {
  try {
    return def.opensUrl?.(input as never) ?? null;
  } catch {
    return null;
  }
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Whether a result shows records holding outside content (an email found by entity_search, a
 * conversation's title in a list of links, a watch kept as untrusted). Reading those lowers
 * trust like record_read does. See holdsOutside.
 */
export function mentionsOutside(kernel: Kernel, value: unknown): Promise<boolean> {
  return holdsOutside(kernel.db, (t) => kernel.registry.isOutsideType(t), value);
}

/** A record as Jarvis reads it: its module's description, plus links both ways. */
export async function describeRecord(
  kernel: Kernel,
  id: string,
  caller: Caller = jarvisCaller("agent"),
): Promise<string | null> {
  return (await readRecord(kernel, id, caller))?.text ?? null;
}

/** Like describeRecord, and says whether an outside tool wrote it (reading it lowers trust). */
export async function readRecord(
  kernel: Kernel,
  id: string,
  caller: Caller = jarvisCaller("agent"),
): Promise<{ text: string; fromOutside: boolean; source: string } | null> {
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
  const outsideType = kernel.registry.isOutsideType(row.type);
  // A record written by Hearth can still quote others (a person's email subjects, the titles
  // of what links to it), so the records it names count too.
  const named = [...text.matchAll(UUID_IN_TEXT)].map((m) => m[0]).filter((x) => x !== id);
  const fromOutside =
    isOutsideRecord(row, (t) => kernel.registry.isOutsideType(t)) ||
    (await mentionsOutside(kernel, named));
  const source = outsideType ? row.type : row.createdBy;
  return { text: fromOutside ? asUntrusted(text, source) : text, fromOutside, source };
}
