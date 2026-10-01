import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "./migrate.ts";
import * as schema from "./schema/index.ts";
import { adminUrl, createTestDatabase, type TestDatabase, withDatabase } from "./testing/index.ts";

// Columns that exist in SQL but are deliberately not in the Drizzle mirror.
const SQL_ONLY = new Set(["entity.search"]);

describe("migrations", () => {
  it("apply, revert and re-apply cleanly on an empty database", async () => {
    const name = `hearth_migrate_${Date.now()}`;
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const pool = new pg.Pool({ connectionString: withDatabase(name) });
    try {
      const all = loadMigrations().map((m) => m.name);
      expect(await migrateUp(pool)).toEqual(all);
      expect(await migrateUp(pool)).toEqual([]);
      expect(await migrateDown(pool, all.length)).toEqual([...all].reverse());
      const left = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_migration'",
      );
      expect(left.rows).toEqual([]);
      expect(await migrateUp(pool)).toEqual(all);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});

describe("schema mirror", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it("matches the SQL tables and columns", async () => {
    const res = await tdb.pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_migration'",
    );
    const inSql = new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const inDrizzle = new Set<string>();
    for (const value of Object.values(schema)) {
      if (typeof value !== "object" || value === null || !("getSQL" in value)) continue;
      const cfg = getTableConfig(value as PgTable);
      for (const col of cfg.columns) inDrizzle.add(`${cfg.name}.${col.name}`);
    }
    const missingInSql = [...inDrizzle].filter((c) => !inSql.has(c));
    const missingInDrizzle = [...inSql].filter((c) => !inDrizzle.has(c) && !SQL_ONLY.has(c));
    expect({ missingInSql, missingInDrizzle }).toEqual({ missingInSql: [], missingInDrizzle: [] });
  });
});
