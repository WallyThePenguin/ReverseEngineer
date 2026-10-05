// Fixed notes (D62): what Jarvis says to a member without a turn, when it won't answer them itself.
// They come from this closed set, filled only with your first name and the workspace's name, so
// nobody's words reach them and no model writes them. Each kind goes to a member at most once a
// day (the outbox key says which day): a member who keeps writing while Jarvis is paused hears it
// once, and their messages are passed on to you.
import { localDate } from "@hearth/core";
import { slackUser, slackWorkspace } from "@hearth/db";
import { type ActionContext, getSetting } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { appendLog } from "../../chat/log.ts";
import { enqueue } from "../bot/queue.ts";
import { cleanName } from "./people.ts";

export type NoteKind = "busy" | "paused" | "late" | "sorry" | "too_long" | "blocked";

interface Names {
  owner: string;
  workspace: string;
}

const NOTES: Record<NoteKind, (n: Names) => string> = {
  busy: (n) =>
    `Thanks! I can't answer more messages right now, so I've passed this on to ${n.owner}.`,
  paused: (n) => `I'm paused at the moment, so I've passed your message on to ${n.owner}.`,
  late: (n) =>
    `Sorry, I was offline when you wrote and only just saw this. I've passed it on to ${n.owner}.`,
  sorry: (n) => `Sorry, I couldn't answer this time. I've passed your message on to ${n.owner}.`,
  too_long: (n) =>
    `That's longer than I can take in one message, so I've passed it on to ${n.owner}.`,
  blocked: (n) =>
    `I can't take messages from you in ${n.workspace}. Please reach ${n.owner} another way.`,
};

/** Your first name as Slack has it, and the workspace's name: all a note ever says of anyone. */
async function names(ctx: ActionContext, teamId: string): Promise<Names> {
  const [ws] = await ctx.tx.select().from(slackWorkspace).where(eq(slackWorkspace.teamId, teamId));
  const [me] = ws
    ? await ctx.tx
        .select({ name: slackUser.name })
        .from(slackUser)
        .where(eq(slackUser.id, ws.userId))
    : [];
  const first = cleanName(me?.name, "").split(" ")[0];
  return {
    owner: first || "the person I work for",
    workspace: cleanName(ws?.teamName, "this workspace"),
  };
}

export interface NoteTo {
  teamId: string;
  /** The member's principal: one note of a kind a day each. */
  principal: string;
  /** Their DM with the bot, and the thread they wrote in, if they did. */
  channelId: string;
  threadTs?: string | null;
  conversationId?: string | null;
}

/** The note's text, for tests and the log. */
export const noteText = (kind: NoteKind, n: Names) => NOTES[kind](n);

/**
 * Sends a fixed note, unless that member had this kind of note today. Logged in their
 * conversation as what Jarvis said. Returns whether one was queued.
 */
export async function sendNote(ctx: ActionContext, kind: NoteKind, to: NoteTo): Promise<boolean> {
  const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
  const text = NOTES[kind](await names(ctx, to.teamId));
  const { row, created } = await enqueue(ctx, {
    dedupeKey: `note:${kind}:${to.principal}:${localDate(ctx.now, timeZone)}`,
    teamId: to.teamId,
    channelId: to.channelId,
    threadTs: to.threadTs ?? null,
    text,
    kind: "note",
    conversationId: to.conversationId ?? null,
  });
  if (created && to.conversationId) {
    const [idx] = await appendLog(
      ctx.tx,
      to.conversationId,
      [{ kind: "assistant_message", payload: { text, note: kind, outboxId: row.id } }],
      ctx.now,
    );
    ctx.emit({
      kind: "conversation.appended",
      entityId: to.conversationId,
      payload: { conversationId: to.conversationId, idx, kind: "assistant_message" },
    });
  }
  return created;
}
