import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A transaction handle; every query helper accepts either. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

// Postgres bigint (int8) comes back as a string by default; event seqs fit in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));

export function connect(url: string, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEARTH_DATABASE_URL ?? "postgres://hearth:hearth@localhost:5432/hearth";
}
