// 0040_always_allow on a database with rules in it (D70): on the way down, a rule narrowed to one
// channel or person goes (it can't be kept without its place, so Jarvis asks again there), a rule
// for any target stays, and one rule per action comes back. On the way up again, the rule kept
// covers any target.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

const q = (sql: string, params: unknown[] = []) => tdb.pool.query(sql, params);
const NAME = "0040_always_allow";
/** This migration and any after it, oldest first: what going below it reverts. */
const SINCE = loadMigrations()
  .map((m) => m.name)
  .filter((n) => n >= NAME);

const rule = (action: string, target: string | null) =>
  q(
    "INSERT INTO standing_rule (id, action, principal, target) VALUES (gen_random_uuid(), $1, 'jarvis', $2)",
    [action, target],
  );
const rules = async () =>
  (await q("SELECT action, note FROM standing_rule WHERE principal = 'jarvis' ORDER BY action"))
    .rows;
const column = async (table: string, name: string) =>
  (
    await q("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [
      table,
      name,
    ])
  ).rowCount === 1;

describe("0040_always_allow", () => {
  it("drops the narrow rules on the way down, and keeps the one for any target", async () => {
    await rule("task.create", null);
    await rule("slack.post_in_channel", "C1");
    await rule("slack.post_in_channel", "C2");
    await rule("slack.dm", "U1");
    await q(
      `INSERT INTO approval (id, action, input, input_hash, risk, summary, reason, requested_by, origin, always_allow)
       VALUES (gen_random_uuid(), 'slack.dm', '{}', 'x', 'outward', 'Message Sam', 'Asks', 'jarvis', 'owner',
       '{"target": "U1", "says": "messaging Sam on Slack"}')`,
    );

    expect(await migrateDown(tdb.pool, SINCE.length)).toEqual([...SINCE].reverse());
    expect(await rules()).toEqual([{ action: "task.create", note: "" }]);
    expect(await column("standing_rule", "target")).toBe(false);
    expect(await column("approval", "always_allow")).toBe(false);
    // One rule per action again.
    await expect(
      q(
        "INSERT INTO standing_rule (id, action, principal) VALUES (gen_random_uuid(), 'task.create', 'jarvis')",
      ),
    ).rejects.toThrow(/standing_rule_action_principal_key/);

    expect(await migrateUp(tdb.pool)).toEqual(SINCE);
    expect(
      (await q("SELECT action, target FROM standing_rule WHERE principal = 'jarvis'")).rows,
    ).toEqual([{ action: "task.create", target: null }]);
    // Still one for any target, beside as many narrow ones as there are places.
    await expect(rule("task.create", null)).rejects.toThrow(/standing_rule_scope/);
    await rule("task.create", "C1");
  });
});
