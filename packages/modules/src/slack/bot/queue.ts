// Jarvis's Slack outbox, as rows (D62). Every post goes through it, whoever asked: a member turn's
// answer, a reply you approved, your own "tell Sam", a fixed note. An action only adds a row and
// wakes the worker (pg_notify); the worker's sender (outbox.ts) is the one process that posts, so
// each post happens once even on a PC that sleeps, restarts and deploys.
//
// A row is claimed FOR UPDATE SKIP LOCKED and marked `sending` before Slack is called, so a crash
// mid-call leaves it `sending`; after a minute it's read back before it's posted again. The pace is
// at most one post a second in a place and 20 a minute in all.
import { type Db, type SlackOutboxKind, slackBot, slackOutbox } from "@hearth/db";
import { type ActionContext, ActionError, newId } from "@hearth/kernel";
import { and, asc, count, eq, gt, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { closeNotSent, forgetUnsaid } from "./not-sent.ts";

export type OutboxRow = typeof slackOutbox.$inferSelect;

/** What the worker listens on: a new row wakes the sender at once. It also looks every 5 s. */
export const OUTBOX_CHANNEL = "hearth_slack_outbox";
export const OUTBOX_POLL_MS = 5_000;
/** At most one post a second in one place (D62). */
export const PACE_MS = 1_000;
/** And at most 20 a minute in all. */
export const PER_MINUTE = 20;
/** A row left `sending` this long was cut short (a crash, no answer): it's read back first. */
export const SENDING_STALE_MS = 60_000;
/** A row still waiting a day later expires, and you're told. */
export const OUTBOX_EXPIRES_MS = 24 * 3_600_000;

export interface NewPost {
  /** Keeps a rerun from adding a second row: answer:<turn> for a member turn's answer. */
  dedupeKey: string;
  teamId: string;
  /** A channel, a DM, or a user's id for the bot's DM with them (opened when it's sent). */
  channelId: string;
  threadTs?: string | null;
  ephemeralTo?: string | null;
  text: string;
  kind: SlackOutboxKind;
  conversationId?: string | null;
  turnId?: string | null;
}

/**
 * Adds a post to the outbox in the caller's transaction, and wakes the worker when it commits.
 * The same dedupe key twice gives back the row already there. It holds the bot's row until then,
 * so disconnecting the bot meanwhile waits, and then settles this post with the rest; with the
 * bot gone, nothing is added (D62).
 */
export async function enqueue(
  ctx: Pick<ActionContext, "tx" | "now" | "caller">,
  post: NewPost,
): Promise<{ row: OutboxRow; created: boolean }> {
  const [bot] = await ctx.tx
    .select({ teamId: slackBot.teamId })
    .from(slackBot)
    .where(eq(slackBot.teamId, post.teamId))
    .for("key share");
  if (!bot) throw new ActionError("unavailable", "The Jarvis bot in Slack isn't connected.");
  const [made] = await ctx.tx
    .insert(slackOutbox)
    .values({
      id: newId(),
      ...post,
      createdBy: ctx.caller.principal,
      createdAt: ctx.now,
      notBefore: ctx.now,
      expiresAt: new Date(ctx.now.getTime() + OUTBOX_EXPIRES_MS),
    })
    .onConflictDoNothing({ target: slackOutbox.dedupeKey })
    .returning();
  if (made) {
    await ctx.tx.execute(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, ${made.id})`);
    return { row: made, created: true };
  }
  const [had] = await ctx.tx
    .select()
    .from(slackOutbox)
    .where(eq(slackOutbox.dedupeKey, post.dedupeKey));
  return { row: had!, created: false };
}

export type Claim =
  | { kind: "row"; row: OutboxRow; recovering: boolean }
  /** Something is due, but the pace holds it back for now. */
  | { kind: "paced" }
  | { kind: "none" };

const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

/**
 * The next post to make, marked `sending` (committed) before Slack is called. A row left
 * `sending` for a minute comes back as `recovering`: it may have gone out, so it's read back
 * before it's posted again. One whose read-back Slack asked to wait waits until `notBefore` too.
 */
export function claimNext(db: Db, teamId: string, now: Date): Promise<Claim> {
  return db.transaction(async (tx) => {
    const team = eq(slackOutbox.teamId, teamId);
    const due = and(
      team,
      lte(slackOutbox.notBefore, now),
      or(
        eq(slackOutbox.state, "queued"),
        and(
          eq(slackOutbox.state, "sending"),
          lte(slackOutbox.sendingAt, ago(now, SENDING_STALE_MS)),
        ),
      ),
    );
    const [lastMinute] = await tx
      .select({ n: count() })
      .from(slackOutbox)
      .where(and(team, gt(slackOutbox.sendingAt, ago(now, 60_000))));
    const busy = tx
      .select({ channel: slackOutbox.channelId })
      .from(slackOutbox)
      .where(and(team, gt(slackOutbox.sendingAt, ago(now, PACE_MS))));
    const [row] =
      (lastMinute?.n ?? 0) >= PER_MINUTE
        ? []
        : await tx
            .select()
            .from(slackOutbox)
            .where(and(due, notInArray(slackOutbox.channelId, busy)))
            .orderBy(asc(slackOutbox.createdAt), asc(slackOutbox.id))
            .limit(1)
            .for("update", { skipLocked: true });
    if (!row) {
      const [waiting] = await tx
        .select({ id: slackOutbox.id })
        .from(slackOutbox)
        .where(due)
        .limit(1);
      return waiting ? { kind: "paced" } : { kind: "none" };
    }
    const sending = { state: "sending" as const, sendingAt: now, attempts: row.attempts + 1 };
    await tx.update(slackOutbox).set(sending).where(eq(slackOutbox.id, row.id));
    return { kind: "row", row: { ...row, ...sending }, recovering: row.state === "sending" };
  });
}

/** How a post ended up, or what happens to it next. */
export type Settle =
  | { state: "sent"; sentTs: string | null }
  | { state: "failed" | "expired" | "unknown"; error: string }
  /** Not posted: try again after `notBefore`. */
  | { state: "queued"; notBefore: Date; error: string }
  /**
   * Maybe posted: read back once it's been a minute, and not before `notBefore` when Slack asked
   * the read-back to wait. Never queued again, which would post it without looking (D62).
   */
  | { state: "sending"; error: string; notBefore?: Date };

/**
 * Saves how a claimed post went, unless something else closed it meanwhile. That Slack has it
 * counts even then: disconnecting the bot marks a post being sent "may not have gone out", and if
 * it did go after all, it's sent, and that card closes. Disconnecting Slack takes the row with the
 * workspace, and the card still closes. An answer that didn't go ends its DM's session.
 */
export function settle(db: Db, row: OutboxRow, s: Settle, now: Date): Promise<boolean> {
  const finished = s.state !== "queued" && s.state !== "sending";
  const set = {
    ...s,
    ...(s.state === "sent" ? { error: null } : {}),
    ...(finished ? { finishedAt: now } : {}),
  };
  const from = s.state === "sent" ? ["sending" as const, "unknown" as const] : ["sending" as const];
  return db.transaction(async (tx) => {
    const done = await tx
      .update(slackOutbox)
      .set(set)
      .where(and(eq(slackOutbox.id, row.id), inArray(slackOutbox.state, from)))
      .returning();
    if (s.state === "failed" || s.state === "expired") await forgetUnsaid(tx, done);
    if (s.state === "sent") await closeNotSent(tx, row.id, now);
    return done.length > 0;
  });
}

/** Slack asked the bot to slow down: nothing else of the workspace's goes before `until` either. */
export async function holdQueued(db: Db, teamId: string, until: Date) {
  await db
    .update(slackOutbox)
    .set({ notBefore: until })
    .where(
      and(
        eq(slackOutbox.teamId, teamId),
        eq(slackOutbox.state, "queued"),
        lt(slackOutbox.notBefore, until),
      ),
    );
}

/**
 * Posts that may have gone out, still not looked for a day later because Slack has the bot
 * revoked and nothing can read them back: given up on as "may not have gone out" rather than
 * waiting for new tokens however long that takes. Returns them, for you to be told (D62).
 */
export function giveUpLooking(db: Db, teamId: string, now: Date): Promise<OutboxRow[]> {
  return db
    .update(slackOutbox)
    .set({
      state: "unknown",
      error: "It waited a day: the Jarvis bot couldn't look for it.",
      finishedAt: now,
    })
    .where(
      and(
        eq(slackOutbox.teamId, teamId),
        eq(slackOutbox.state, "sending"),
        lte(slackOutbox.expiresAt, now),
        lte(slackOutbox.sendingAt, ago(now, SENDING_STALE_MS)),
      ),
    )
    .returning();
}

/** Posts still waiting a day later expire. Returns them, for you to be told. */
export function expireWaiting(db: Db, teamId: string, now: Date): Promise<OutboxRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(slackOutbox)
      .set({
        state: "expired",
        error: "It waited a day without going out.",
        finishedAt: now,
      })
      .where(
        and(
          eq(slackOutbox.teamId, teamId),
          eq(slackOutbox.state, "queued"),
          lte(slackOutbox.expiresAt, now),
        ),
      )
      .returning();
    await forgetUnsaid(tx, rows);
    return rows;
  });
}
