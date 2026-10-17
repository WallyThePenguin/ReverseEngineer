// How long approvals wait, what runs them out, and how their cards name records (D58).
import { type Origin, type Risk, weakerOrigin } from "@hearth/core";
import { approval, type Db, type DbOrTx, entity, notification } from "@hearth/db";
import { and, eq, inArray, lte, ne } from "drizzle-orm";
import type { Clock } from "./clock.ts";
import { appendEvents } from "./events.ts";
import { isOutsideRecord } from "./outside.ts";
import type { ActionDef } from "./types.ts";

const HOUR = 3600_000;

/**
 * How long an approval waits for your yes, by risk. A step held back because the turn had read
 * outside content (opening a page, typing on a site: read and internal risk) is about the page
 * as it is now, so it runs out soon. Sending and changing your accounts wait a day, and putting
 * things in the trash three.
 */
export function approvalTtlMs(risk: Risk): number {
  if (risk === "read" || risk === "internal") return 2 * HOUR;
  if (risk === "destructive") return 72 * HOUR;
  return 24 * HOUR;
}

/** An approval still "executing" this long after its yes was cut short (Hearth stopped). */
export const STUCK_MS = 15 * 60_000;
const CUT_SHORT =
  "Nook stopped while doing this, so it may or may not have happened. Check before asking again.";

/**
 * What Jarvis hears about a decision carries the request's trust (the turn it resumes is no more
 * trusted than the one that asked), and an action whose result is outside content (a page it
 * pressed something on, an email it found) makes it untrusted whoever asked (D25, D58).
 */
export function resolvedOrigin(
  row: { origin: string },
  def: Pick<ActionDef, "external"> | undefined,
  touchedOutside = false,
): Origin {
  if (def?.external || touchedOutside) return "untrusted";
  return weakerOrigin(row.origin as Origin, "owner");
}

/**
 * Runs out approvals past their time, and closes ones a restart cut short, so nothing waits on
 * them for ever. With `onlyId`, just that one (when you decide one that has run out). Their
 * inbox cards close, and approval.resolved says what happened. Returns how many closed.
 */
export async function expireOverdue(db: Db, now: Date, onlyId?: string): Promise<number> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .update(approval)
      .set({ status: "expired", decidedAt: now })
      .where(
        and(
          eq(approval.status, "pending"),
          lte(approval.expiresAt, now),
          onlyId ? eq(approval.id, onlyId) : undefined,
        ),
      )
      .returning();
    const stuck = onlyId
      ? []
      : await tx
          .update(approval)
          .set({ status: "failed", error: CUT_SHORT })
          .where(
            and(
              eq(approval.status, "executing"),
              lte(approval.decidedAt, new Date(now.getTime() - STUCK_MS)),
            ),
          )
          .returning();
    const closed = [...expired, ...stuck];
    if (closed.length === 0) return 0;
    await tx
      .update(notification)
      .set({ state: "done", updatedAt: now })
      .where(
        and(
          inArray(
            notification.approvalId,
            closed.map((r) => r.id),
          ),
          ne(notification.state, "done"),
        ),
      );
    for (const row of closed) {
      await appendEvents(
        tx,
        [
          {
            kind: "approval.resolved",
            payload: {
              approvalId: row.id,
              action: row.action,
              decision: row.status === "expired" ? "expired" : "approved",
              requestedBy: row.requestedBy,
              conversationId: row.conversationId,
              turnId: row.turnId,
              ...(row.error ? { error: row.error } : {}),
            },
          },
        ],
        {
          actor: "system",
          origin: row.origin === "untrusted" ? "untrusted" : "system",
          correlationId: row.correlationId,
          at: now,
        },
      );
    }
    return closed.length;
  });
}

/** The scheduler's sweep: see expireOverdue. */
export function expireApprovals(db: Db, clock: Clock): Promise<number> {
  return expireOverdue(db, clock.now());
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A card's line with the records it names by id shown by their titles instead: "Move record
 * "Renew passport" to trash". Only titles Hearth's own side wrote: an email's subject could say
 * anything, and Jarvis reads the inbox too, so those keep their ids.
 */
export async function withTitles(
  db: DbOrTx,
  text: string,
  isOutsideType: (type: string) => boolean,
): Promise<string> {
  const ids = [...new Set((text.match(UUID_IN_TEXT) ?? []).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return text;
  const rows = await db
    .select({
      id: entity.id,
      title: entity.title,
      type: entity.type,
      createdBy: entity.createdBy,
      outside: entity.outside,
    })
    .from(entity)
    .where(inArray(entity.id, ids.slice(0, 20)));
  const titles = new Map(
    rows
      .filter((r) => r.title.trim() && !isOutsideRecord(r, isOutsideType))
      .map((r) => {
        const t = r.title.replace(/\s+/g, " ").trim();
        return [r.id, `"${t.length > 80 ? `${t.slice(0, 79)}…` : t}"`] as const;
      }),
  );
  return text.replace(UUID_IN_TEXT, (id) => titles.get(id.toLowerCase()) ?? id);
}
