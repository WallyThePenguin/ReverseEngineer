// Store, then ack (D62): Slack hears back only about what's stored, each message is stored once
// however it comes, the ack path has a connection of its own, and what members wrote is cleared
// after 30 days.
import { slackInbound } from "@hearth/db";
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearOldInbound, INBOUND_POOL, inboundStore, receive, storeInbound } from "./inbound.ts";
import { inboundRow, type Ours } from "./socket.ts";

let db: TestDatabase;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(() => db.destroy());

const ours: Ours = { appId: "A0C0RPY4WKV", teamId: "T1", botUserId: "UJARVIS" };
const at = new Date("2026-10-05T12:00:00Z");
const envelope = (ts: string, text = "hi") => ({
  envelopeId: `env-${ts}`,
  payload: {
    team_id: "T1",
    api_app_id: "A0C0RPY4WKV",
    authorizations: [{ user_id: "UJARVIS", is_bot: true }],
    event: { type: "message", channel_type: "im", channel: "DUANA", user: "UANA", text, ts },
  },
});

describe("store, then ack", () => {
  it("acks only after the message is stored, and acks what it drops", async () => {
    const order: string[] = [];
    const store = {
      store: async (rows: unknown[]) => {
        order.push(`stored ${rows.length}`);
        return rows.length;
      },
    };
    await receive(envelope("1.0"), ours, store, (id) => order.push(`ack ${id}`), at);
    const bot = envelope("2.0");
    (bot.payload.event as Record<string, unknown>).bot_id = "B1";
    await receive(bot, ours, store, (id) => order.push(`ack ${id}`), at);
    expect(order).toEqual(["stored 1", "ack env-1.0", "ack env-2.0"]);
  });

  it("doesn't ack when the store fails, so Slack sends it again", async () => {
    const acks: string[] = [];
    const failing = {
      store: async () => {
        throw new Error("canceling statement due to statement timeout");
      },
    };
    await expect(
      receive(envelope("1.0"), ours, failing, (id) => acks.push(id), at),
    ).rejects.toThrow(/statement timeout/);
    expect(acks).toEqual([]);
  });

  it("stores each message once, on a connection of its own with a short timeout", async () => {
    expect(INBOUND_POOL).toEqual({ max: 1, statementTimeoutMs: 2000 });
    const store = inboundStore(db.url);
    try {
      const acks: string[] = [];
      for (const ts of ["1.0", "1.0", "2.0"])
        await receive(envelope(ts), ours, store, (id) => acks.push(id), at);
      expect(acks).toHaveLength(3);
      const rows = await db.db.select().from(slackInbound).orderBy(slackInbound.ts);
      expect(rows.map((r) => [r.ts, r.source, r.receivedAt])).toEqual([
        ["1.0", "event", at],
        ["2.0", "event", at],
      ]);
    } finally {
      await store.close();
    }
  });
});

describe("keeping what members wrote", () => {
  it("clears the text after 30 days and keeps the row, so a late copy is still known", async () => {
    const row = (ts: string, daysAgo: number) =>
      inboundRow(
        { channel: "DUANA", ts, user: "UANA", text: `said ${ts}`, teams: [] },
        "T1",
        "event",
        new Date(at.getTime() - daysAgo * 86_400_000),
      );
    await storeInbound(db.db, [row("1.0", 31), row("2.0", 29)]);
    expect(await clearOldInbound(db.db, at)).toBe(1);
    expect(await clearOldInbound(db.db, at)).toBe(0);
    const rows = await db.db.select().from(slackInbound).orderBy(slackInbound.ts);
    expect(rows.map((r) => r.text)).toEqual([null, "said 2.0"]);
    // The same message arriving again doesn't bring the text back.
    expect(await storeInbound(db.db, [row("1.0", 0)])).toBe(0);
  });
});
