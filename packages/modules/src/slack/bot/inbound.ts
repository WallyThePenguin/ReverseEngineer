// Store, then ack (D62). Slack keeps nothing for Hearth: an envelope it doesn't see acked within a
// few seconds is sent again, and after a few tries it's gone. So every message the socket hears is
// written to slack_inbound first, and only then is Slack told it arrived. If the write fails,
// there's no ack and Slack tries again. Nothing calls Slack before the ack; who wrote it is worked
// out later, by the take loop.
//
// The writes go over a connection of their own (one, with a 2 s statement timeout), so a sync
// round holding the worker's pool can't make Slack wait. (channel_id, ts) is the key: a retry, two
// sockets during a handover, an app_mention and a message.im for one message, and catch-up each
// store a message once.
import { connect, type DbOrTx, slackInbound } from "@hearth/db";
import { and, isNotNull, lt } from "drizzle-orm";
import { type Hearing, hear, type InboundRow, type Ours } from "./socket.ts";

/** The ack path's connection: alone, and quick to give up so Slack's retry takes over. */
export const INBOUND_POOL = { max: 1, statementTimeoutMs: 2000 } as const;

export interface InboundStore {
  /** Stores what was heard, each message once however often it comes. Returns how many were new. */
  store(rows: InboundRow[]): Promise<number>;
  close(): Promise<void>;
}

export async function storeInbound(db: DbOrTx, rows: InboundRow[]): Promise<number> {
  if (!rows.length) return 0;
  const made = await db
    .insert(slackInbound)
    .values(rows)
    .onConflictDoNothing()
    .returning({ ts: slackInbound.ts });
  return made.length;
}

/**
 * The store on its own connection to `url`. No default address: a test that forgot to pass its own
 * database mustn't reach the live one.
 */
export function inboundStore(url: string): InboundStore {
  const database = connect(url, INBOUND_POOL);
  return {
    store: (rows) => storeInbound(database.db, rows),
    close: () => database.close(),
  };
}

/**
 * One envelope: checked, stored, then acked. A store that fails throws before the ack, so Slack
 * sends the envelope again. Anything dropped is acked too, or Slack would keep sending it.
 */
export async function receive(
  envelope: { envelopeId: string; payload: Record<string, unknown> },
  ours: Ours,
  store: Pick<InboundStore, "store">,
  ack: (envelopeId: string) => void,
  at: Date,
): Promise<Hearing> {
  const heard = hear(envelope.payload, ours, at);
  if (heard.kind === "store") await store.store([heard.row]);
  ack(envelope.envelopeId);
  return heard;
}

/** What members wrote is kept 30 days (D62); the row stays, so a late redelivery is still known. */
export const INBOUND_TEXT_DAYS = 30;

export async function clearOldInbound(db: DbOrTx, now: Date): Promise<number> {
  const before = new Date(now.getTime() - INBOUND_TEXT_DAYS * 86_400_000);
  const cleared = await db
    .update(slackInbound)
    .set({ text: null })
    .where(and(isNotNull(slackInbound.text), lt(slackInbound.receivedAt, before)))
    .returning({ ts: slackInbound.ts });
  return cleared.length;
}
