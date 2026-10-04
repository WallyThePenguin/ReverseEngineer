import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationState,
  schemaMismatch,
} from "./migrate.ts";
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
      // pool.end() resolves before the server has closed those backends. Wait for them, or
      // FORCE kills one mid-close and its FATAL message escapes as an uncaught error.
      for (let i = 0; i < 50; i++) {
        const open = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1", [name]);
        if (open.rowCount === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
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

describe("whether the database fits this code", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it("tells a database that's behind from one that's ahead", async () => {
    const all = loadMigrations().map((m) => m.name);
    const fits = await migrationState(tdb.pool);
    expect(fits).toMatchObject({ expected: all, applied: all, missing: [], unknown: [] });
    expect(schemaMismatch(fits)).toBeNull();

    const last = all.at(-1)!;
    await tdb.pool.query("DELETE FROM _migration WHERE name = $1", [last]);
    const behind = await migrationState(tdb.pool);
    expect(behind.missing).toEqual([last]);
    expect(schemaMismatch(behind)).toMatch(/missing 1 update.*Run `hearth migrate`/);

    await tdb.pool.query("INSERT INTO _migration (name) VALUES ($1), ('9999_from_the_future')", [
      last,
    ]);
    const ahead = await migrationState(tdb.pool);
    expect(ahead).toMatchObject({ missing: [], unknown: ["9999_from_the_future"] });
    expect(schemaMismatch(ahead)).toMatch(/newer than the code/);
  });

  it("counts an empty database as missing everything", async () => {
    const name = `hearth_migrate_${Date.now()}`;
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const pool = new pg.Pool({ connectionString: withDatabase(name) });
    try {
      const state = await migrationState(pool);
      expect(state.applied).toEqual([]);
      expect(state.missing).toEqual(loadMigrations().map((m) => m.name));
    } finally {
      await pool.end();
      for (let i = 0; i < 50; i++) {
        const open = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = $1", [name]);
        if (open.rowCount === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
