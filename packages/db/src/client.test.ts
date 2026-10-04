// The pool's limits are set on each connection as it opens, and migrations run without them.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./client.ts";
import { migrateDown, migrateUp } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

const show = async (db: { pool: { query: (q: string) => Promise<{ rows: unknown[] }> } }) => {
  const { rows } = await db.pool.query(
    "SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle",
  );
  return rows[0];
};

describe("database connections", () => {
  it("cancel a statement after a minute and end a transaction left idle for five", async () => {
    expect(await show(tdb)).toEqual({ statement: "1min", idle: "5min" });
  });

  it("can be given other limits, or none", async () => {
    const quick = connect(tdb.url, { max: 1, statementTimeoutMs: 200 });
    const open = connect(tdb.url, { max: 1, statementTimeoutMs: 0, idleInTransactionMs: 0 });
    try {
      await expect(quick.pool.query("SELECT pg_sleep(1)")).rejects.toMatchObject({
        code: "57014",
      });
      expect(await show(open)).toEqual({ statement: "0", idle: "0" });
    } finally {
      await quick.close();
      await open.close();
    }
  });

  it("run migrations without the limit, and give the connection back with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-migrations-"));
    writeFileSync(join(dir, "9999_slow.up.sql"), "SELECT pg_sleep(0.3);");
    writeFileSync(join(dir, "9999_slow.down.sql"), "SELECT pg_sleep(0.3);");
    const one = connect(tdb.url, { max: 1, statementTimeoutMs: 100 });
    try {
      expect(await migrateUp(one.pool, dir)).toEqual(["9999_slow"]);
      expect(await migrateDown(one.pool, 1, dir)).toEqual(["9999_slow"]);
      expect(await show(one)).toEqual({ statement: "100ms", idle: "5min" });
    } finally {
      await one.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run a migration's code steps in its transaction: up after the SQL, down before it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-migrations-"));
    writeFileSync(join(dir, "9998_code.up.sql"), "CREATE TABLE code_step (v text);");
    writeFileSync(join(dir, "9998_code.down.sql"), "DROP TABLE code_step;");
    const seen: unknown[] = [];
    const steps = (fail = false) => ({
      "9998_code": {
        async up(c: { query: (q: string) => Promise<unknown> }) {
          await c.query("INSERT INTO code_step VALUES ('sealed')");
          if (fail) throw new Error("no key");
        },
        async down(c: { query: (q: string) => Promise<{ rows: unknown[] }> }) {
          seen.push(...(await c.query("SELECT v FROM code_step")).rows);
        },
      },
    });
    const one = connect(tdb.url, { max: 1 });
    try {
      // A step that fails leaves the migration undone, its SQL included.
      await expect(migrateUp(one.pool, dir, steps(true))).rejects.toThrow(/9998_code failed/);
      const table = await one.pool.query("SELECT to_regclass('code_step') AS t");
      expect(table.rows[0]).toEqual({ t: null });
      expect(await migrateUp(one.pool, dir, steps())).toEqual(["9998_code"]);
      expect(await migrateDown(one.pool, 1, dir, steps())).toEqual(["9998_code"]);
      expect(seen).toEqual([{ v: "sealed" }]);
    } finally {
      await one.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
