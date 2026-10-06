// 0033_slack_bot on a database with rows in it: Slack members arrive as a new kind of principal,
// and on the way down what they wrote goes before they do (D62).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

const q = (sql: string, params: unknown[] = []) => tdb.pool.query(sql, params);
const NAME = "0033_slack_bot";
/** This migration and any after it, oldest first: what going below it reverts. */
const SINCE = loadMigrations()
  .map((m) => m.name)
  .filter((n) => n >= NAME);
const down = async () =>
  expect(await migrateDown(tdb.pool, SINCE.length)).toEqual([...SINCE].reverse());
const up = async () => expect(await migrateUp(tdb.pool)).toEqual(SINCE);

const SAM = "member:slack:T1:U_SAM";
const TEAM = "member:slack:T1:*";
const ids = {
  left: "00000000-0000-7000-8000-0000000000a1",
  chat: "00000000-0000-7000-8000-0000000000a2",
  mine: "00000000-0000-7000-8000-0000000000a3",
  approval: "00000000-0000-7000-8000-0000000000a4",
};

const column = async (table: string, name: string) =>
  (
    await q("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [
      table,
      name,
    ])
  ).rowCount === 1;

describe("0033_slack_bot", () => {
  it("starts everyone at relay with replies on their own, and every channel off", async () => {
    await down();
    await q(
      "INSERT INTO slack_workspace (team_id, team_name, url, user_id, token) VALUES ('T1', 'Otopair', 'https://otopair.slack.com', 'U_ME', 'sealed')",
    );
    await q(
      "INSERT INTO slack_channel (id, team_id, name, kind) VALUES ('C1', 'T1', 'general', 'channel'), ('G1', 'T1', 'mpdm', 'group')",
    );
    await q("INSERT INTO slack_user (id, team_id, name) VALUES ('U_SAM', 'T1', 'Sam Lee')");
    await up();
    expect((await q("SELECT tier, replies, vip, guest, principal FROM slack_user")).rows).toEqual([
      { tier: "relay", replies: "auto", vip: false, guest: false, principal: null },
    ]);
    expect(
      (await q("SELECT id, jarvis_tier, jarvis_replies FROM slack_channel ORDER BY id")).rows,
    ).toEqual([
      { id: "C1", jarvis_tier: "off", jarvis_replies: "review" },
      { id: "G1", jarvis_tier: "off", jarvis_replies: "review" },
    ]);
    await q("UPDATE slack_channel SET jarvis_tier = 'relay' WHERE id = 'C1'");
    // A group DM is never on.
    await expect(
      q("UPDATE slack_channel SET jarvis_tier = 'relay' WHERE id = 'G1'"),
    ).rejects.toThrow(/slack_channel_jarvis_where/);
  });

  it("takes members, and what they wrote, away on the way down, and comes back", async () => {
    await q(
      "INSERT INTO principal (id, kind, display_name) VALUES ($1, 'member', 'Sam Lee'), ($2, 'member', 'Otopair')",
      [SAM, TEAM],
    );
    await q("UPDATE slack_user SET principal = $1, tier = 'schedule' WHERE id = 'U_SAM'", [SAM]);
    // A message Sam left you, Sam's conversation with Jarvis, and a note of your own.
    await q(
      "INSERT INTO entity (id, type, title, created_by, updated_by, outside) VALUES ($1, 'slack_member_message', 'Call me', $3, $3, true), ($2, 'conversation', 'Slack: Sam Lee', 'integration:slack', 'integration:slack', true), ($4, 'note', 'Mine', 'owner', 'owner', false)",
      [ids.left, ids.chat, SAM, ids.mine],
    );
    await q(
      "INSERT INTO conversation (entity_id, started_via, tainted_at) VALUES ($1, 'slack_member', now())",
      [ids.chat],
    );
    await q(
      "INSERT INTO jarvis_turn (id, trigger, mode, lane, origin, prompt, conversation_id) VALUES (gen_random_uuid(), 'slack_member', 'reactive', 'fast', 'untrusted', 'hi', $1)",
      [ids.chat],
    );
    // A held reply with its card, the switch for the whole team, and a rule of Jarvis's.
    await q(
      "INSERT INTO approval (id, action, input, input_hash, risk, summary, reason, requested_by, origin) VALUES ($1, 'slack.reply', '{}', 'h', 'outward', 'Reply as Jarvis to Sam Lee', 'review', $2, 'untrusted')",
      [ids.approval, SAM],
    );
    await q(
      "INSERT INTO notification (id, kind, title, approval_id, created_by) VALUES (gen_random_uuid(), 'approval', 'Sam Lee asks', $1, $2)",
      [ids.approval, SAM],
    );
    await q(
      "INSERT INTO standing_rule (id, action, principal) VALUES (gen_random_uuid(), 'slack.reply', $1), (gen_random_uuid(), 'mail.send', 'jarvis')",
      [TEAM],
    );
    await q(
      "INSERT INTO slack_bot (team_id, app_id, bot_user_id, bot_id, owner_im, install_id, bot_token, app_token) VALUES ('T1', 'A0C0RPY4WKV', 'U_BOT', 'B1', 'D_ME', 'install-1', 'sealed-bot', 'sealed-app')",
    );
    await q(
      "INSERT INTO slack_thread (channel_id, team_id, conversation_id, audience, member) VALUES ('D_SAM', 'T1', $1, 'member', $2)",
      [ids.chat, SAM],
    );
    await q(
      "INSERT INTO slack_inbound (channel_id, ts, team_id, user_id, channel_type, text, source, conversation_id) VALUES ('D_SAM', '1700000000.000100', 'T1', 'U_SAM', 'im', 'Call me', 'event', $1)",
      [ids.chat],
    );
    await q(
      "INSERT INTO slack_outbox (id, dedupe_key, team_id, channel_id, text, kind, conversation_id, approval_id, created_by, expires_at) VALUES (gen_random_uuid(), 'answer:t1', 'T1', 'D_SAM', 'Passed on.', 'answer', $1, $2, $3, now() + interval '1 day')",
      [ids.chat, ids.approval, SAM],
    );
    // A turn's answer is posted once, however often it's written.
    await expect(
      q(
        "INSERT INTO slack_outbox (id, dedupe_key, team_id, channel_id, text, kind, created_by, expires_at) VALUES (gen_random_uuid(), 'answer:t1', 'T1', 'D_SAM', 'Again', 'answer', $1, now())",
        [SAM],
      ),
    ).rejects.toThrow(/slack_outbox_dedupe_key_key/);
    await q(
      "INSERT INTO slack_answer (id, team_id, title, body) VALUES (gen_random_uuid(), 'T1', 'Office hours', 'Tuesdays 2-4')",
    );

    await down();
    expect((await q("SELECT id FROM principal WHERE id LIKE 'member:%'")).rows).toEqual([]);
    expect(
      (await q("SELECT id FROM entity WHERE id = ANY($1)", [Object.values(ids)])).rows,
    ).toEqual([{ id: ids.mine }]);
    expect((await q("SELECT id FROM approval WHERE id = $1", [ids.approval])).rows).toEqual([]);
    expect((await q("SELECT id FROM notification WHERE title = 'Sam Lee asks'")).rows).toEqual([]);
    expect(
      (
        await q(
          "SELECT action, principal FROM standing_rule WHERE action IN ('slack.reply', 'mail.send')",
        )
      ).rows,
    ).toEqual([{ action: "mail.send", principal: "jarvis" }]);
    expect((await q("SELECT to_regclass('slack_bot') AS t")).rows).toEqual([{ t: null }]);
    expect(await column("slack_user", "tier")).toBe(false);
    expect(await column("slack_channel", "jarvis_tier")).toBe(false);
    // The users and channels you'd read in stay.
    expect((await q("SELECT id, name FROM slack_user")).rows).toEqual([
      { id: "U_SAM", name: "Sam Lee" },
    ]);
    await expect(
      q(
        "INSERT INTO principal (id, kind, display_name) VALUES ('member:slack:T1:U2', 'member', 'x')",
      ),
    ).rejects.toThrow(/principal_kind_check/);
    await expect(
      q(
        "INSERT INTO jarvis_turn (id, trigger, mode, lane, origin, prompt) VALUES (gen_random_uuid(), 'slack_member', 'reactive', 'fast', 'untrusted', 'hi')",
      ),
    ).rejects.toThrow(/jarvis_turn_trigger_check/);

    await up();
    await q("INSERT INTO principal (id, kind, display_name) VALUES ($1, 'member', 'Sam Lee')", [
      SAM,
    ]);
    expect((await q("SELECT tier FROM slack_user")).rows).toEqual([{ tier: "relay" }]);
  });
});
