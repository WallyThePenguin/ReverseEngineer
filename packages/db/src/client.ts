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
  // An idle connection dropped by Postgres (a restart, a forced drop) is an error event on the
  // pool; without a listener it would crash the process. The pool replaces the connection.
  pool.on("error", (err) => console.error(`[db] lost an idle connection: ${err.message}`));
  // pool.end() resolves before the sockets close; close() waits for them, so a database can be
  // dropped right after without killing a connection that is still saying goodbye.
  const open = new Set<pg.PoolClient>();
  pool.on("connect", (c) => {
    open.add(c);
    c.once("end", () => open.delete(c));
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    async close() {
      const ended = [...open].map((c) => new Promise((r) => c.once("end", r)));
      await pool.end();
      await Promise.all(ended);
    },
  };
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEARTH_DATABASE_URL ?? "postgres://hearth:hearth@localhost:5432/hearth";
}
