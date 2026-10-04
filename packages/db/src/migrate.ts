// A small migration runner: NNNN_name.up.sql and NNNN_name.down.sql, each run in a transaction.
// Every migration must be reversible (PLAN.md section 11).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

interface Migration {
  name: string;
  up: string;
  down: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const ups = readdirSync(dir)
    .filter((f) => f.endsWith(".up.sql"))
    .sort();
  return ups.map((file) => {
    const name = file.replace(/\.up\.sql$/, "");
    return {
      name,
      up: readFileSync(join(dir, file), "utf8"),
      down: readFileSync(join(dir, `${name}.down.sql`), "utf8"),
    };
  });
}

async function applied(client: pg.PoolClient): Promise<string[]> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS _migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const res = await client.query<{ name: string }>("SELECT name FROM _migration ORDER BY name");
  return res.rows.map((r) => r.name);
}

/**
 * A connection for migrating. The pool cancels statements after a minute (client.ts), which is
 * right for requests but not for building an index on a big table or waiting for another
 * migration to finish, so the limit is lifted here and put back before the connection returns.
 */
async function migrationClient(pool: pg.Pool): Promise<pg.PoolClient> {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
  } catch (err) {
    client.release(err as Error);
    throw err;
  }
  return client;
}

async function releaseMigrationClient(client: pg.PoolClient): Promise<void> {
  const failed = await client.query("RESET statement_timeout").then(
    () => undefined,
    (err: Error) => err,
  );
  // One that can't be reset is closed rather than handed back without its limit.
  client.release(failed);
}

/**
 * A run of migrations that stopped at one that failed. Each commits on its own, so the ones before
 * it stay done: `committed` names them, for an update to revert (ops/windows/update.ps1).
 */
export class MigrationError extends Error {
  readonly committed: string[];
  constructor(message: string, committed: string[]) {
    super(message);
    this.committed = committed;
    this.name = "MigrationError";
  }
}

/** Applies every pending migration. Returns the names applied. */
export async function migrateUp(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await migrationClient(pool);
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('hearth_migrate'))");
    const done = new Set(await applied(client));
    const ran: string[] = [];
    for (const m of loadMigrations(dir)) {
      if (done.has(m.name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.up);
        await client.query("INSERT INTO _migration (name) VALUES ($1)", [m.name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new MigrationError(`Migration ${m.name} failed: ${(err as Error).message}`, ran);
      }
      ran.push(m.name);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('hearth_migrate'))");
    await releaseMigrationClient(client);
  }
}

export interface MigrationState {
  /** What this code's migrations folder has, oldest first. */
  expected: string[];
  /** What the database has applied, oldest first. */
  applied: string[];
  /** Expected but not applied: the database is behind this code. */
  missing: string[];
  /** Applied but unknown to this code: the database is ahead of it. */
  unknown: string[];
}

/** Anything that runs SQL text: a pool, a client, or a Drizzle database (db.execute). */
export interface SqlRunner {
  query<R extends pg.QueryResultRow>(text: string): Promise<{ rows: R[] }>;
}

/** Compares the database's migrations with this code's. Never changes anything. */
export async function migrationState(
  pool: SqlRunner,
  dir = MIGRATIONS_DIR,
): Promise<MigrationState> {
  const expected = loadMigrations(dir).map((m) => m.name);
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('_migration') AS t");
  const applied = exists.rows[0]?.t
    ? (await pool.query<{ name: string }>("SELECT name FROM _migration ORDER BY name")).rows.map(
        (r) => r.name,
      )
    : [];
  const have = new Set(applied);
  const known = new Set(expected);
  return {
    expected,
    applied,
    missing: expected.filter((n) => !have.has(n)),
    unknown: applied.filter((n) => !known.has(n)),
  };
}

/** Why this code and the database don't fit together, in words; null when they do. */
export function schemaMismatch(state: MigrationState): string | null {
  if (state.missing.length)
    return `The database is missing ${state.missing.length} update(s) this code needs (${state.missing.join(", ")}). Run \`hearth migrate\`.`;
  if (state.unknown.length)
    return `The database has update(s) this code doesn't know (${state.unknown.join(", ")}), so it's newer than the code. Update Hearth, or restore the backup taken before the last update.`;
  return null;
}

/**
 * Reverts the last `steps` migrations, or exactly the one named (nothing when it isn't applied):
 * an update reverts what it applied by name, which isn't always the newest. Returns the names
 * reverted.
 */
export async function migrateDown(
  pool: pg.Pool,
  which: number | string = 1,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const client = await migrationClient(pool);
  try {
    const done = await applied(client);
    const byName = new Map(loadMigrations(dir).map((m) => [m.name, m]));
    if (typeof which === "string" && !byName.has(which) && !done.includes(which))
      throw new Error(`No migration named ${which}`);
    const names =
      typeof which === "string" ? done.filter((n) => n === which) : done.reverse().slice(0, which);
    const reverted: string[] = [];
    for (const name of names) {
      const m = byName.get(name);
      if (!m) throw new MigrationError(`No files for applied migration ${name}`, reverted);
      await client.query("BEGIN");
      try {
        await client.query(m.down);
        await client.query("DELETE FROM _migration WHERE name = $1", [name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new MigrationError(`Reverting ${name} failed: ${(err as Error).message}`, reverted);
      }
      reverted.push(name);
    }
    return reverted;
  } finally {
    await releaseMigrationClient(client);
  }
}
