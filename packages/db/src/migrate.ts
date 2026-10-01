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

/** Applies every pending migration. Returns the names applied. */
export async function migrateUp(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
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
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
      ran.push(m.name);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('hearth_migrate'))");
    client.release();
  }
}

/** Reverts the last `steps` migrations. Returns the names reverted. */
export async function migrateDown(
  pool: pg.Pool,
  steps = 1,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const client = await pool.connect();
  try {
    const done = await applied(client);
    const byName = new Map(loadMigrations(dir).map((m) => [m.name, m]));
    const reverted: string[] = [];
    for (const name of done.reverse().slice(0, steps)) {
      const m = byName.get(name);
      if (!m) throw new Error(`No files for applied migration ${name}`);
      await client.query("BEGIN");
      try {
        await client.query(m.down);
        await client.query("DELETE FROM _migration WHERE name = $1", [name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Reverting ${name} failed: ${(err as Error).message}`);
      }
      reverted.push(name);
    }
    return reverted;
  } finally {
    client.release();
  }
}
