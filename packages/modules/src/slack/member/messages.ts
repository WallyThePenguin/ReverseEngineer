// A member's messages as the take loop and their turn handle them (D62). Each slack_inbound row of
// theirs moves on once, and stays among the untaken (taken_at null, the index the loop reads)
// until it's settled:
//   new (no outcome) → waiting (logged in their conversation, a turn to come)
//                    → claimed (a turn folded it in) → answered | held | relayed
//   or straight to relayed, blocked or ignored:<why> when there's no turn for it.
// Relayed means passed on to you with a fixed note to them; every way a message can go
// unanswered ends there, so nothing a member writes is lost.
import { type DbOrTx, slackInbound, slackUser } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, eq, inArray } from "drizzle-orm";
import { plainText } from "../save.ts";
import { type NoteKind, sendNote } from "./notes.ts";
import { passOn } from "./relay.ts";

export type InboundRow = typeof slackInbound.$inferSelect;

/** What's settled about a message for good. */
export type Settled = "answered" | "held" | "relayed" | "blocked" | `ignored:${string}`;

/** Messages more than this late (by Slack's time) get a note, not an answer (D62). */
export const LATE_MS = 2 * 3_600_000;
/** Messages answered this late start "Sorry for the slow reply". */
export const SLOW_MS = 10 * 60_000;
/** A message Hearth had this long without a turn answering it is passed on (D62). */
export const WAIT_MS = 10 * 60_000;

/** When Slack says a message was written. */
export const writtenAt = (ts: string) => new Date(Math.floor(Number(ts) * 1000));

/** Slack's markup as plain text, with @names from the people Hearth knows (no calls to Slack). */
export async function plainOf(db: DbOrTx, text: string | null): Promise<string> {
  const raw = text ?? "";
  const ids = [...new Set([...raw.matchAll(/<@([A-Z0-9]+)/g)].map((m) => m[1]!))].slice(0, 20);
  const names = new Map<string, string>();
  if (ids.length)
    for (const u of await db
      .select({ id: slackUser.id, name: slackUser.name })
      .from(slackUser)
      .where(inArray(slackUser.id, ids)))
      names.set(u.id, u.name);
  return plainText(raw, names);
}

/** Settles messages: taken, with what happened to them. */
export async function settle(ctx: ActionContext, rows: InboundRow[], outcome: Settled) {
  if (!rows.length) return;
  for (const r of rows)
    await ctx.tx
      .update(slackInbound)
      .set({ outcome, takenAt: ctx.now })
      .where(and(eq(slackInbound.channelId, r.channelId), eq(slackInbound.ts, r.ts)));
}

export interface Writer {
  teamId: string;
  principal: string;
  name: string;
  vip: boolean;
  conversationId: string | null;
}

/**
 * Passes messages Jarvis won't answer on to you, tells the member why with a fixed note (once a
 * day), and settles them as relayed.
 */
export async function relayRows(
  ctx: ActionContext,
  who: Writer,
  rows: InboundRow[],
  note: NoteKind,
) {
  if (!rows.length) return;
  const texts: string[] = [];
  for (const r of rows) texts.push(await plainOf(ctx.tx, r.text));
  await passOn(ctx, {
    principal: who.principal,
    name: who.name,
    text: texts.join("\n\n"),
    kind: "unanswered",
    vip: who.vip,
  });
  const last = rows.at(-1)!;
  await sendNote(ctx, note, {
    teamId: who.teamId,
    principal: who.principal,
    channelId: last.channelId,
    threadTs: last.threadTs,
    conversationId: who.conversationId,
  });
  await settle(ctx, rows, "relayed");
}
