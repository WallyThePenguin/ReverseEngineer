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

export interface ConnectOptions {
  max?: number;
  /** Connections kept open through quiet spells, so the next request doesn't wait for one. */
  min?: number;
  /** A statement running longer is cancelled. 0 means no limit. */
  statementTimeoutMs?: number;
  /**
   * A transaction left open and idle longer is ended, so a stuck request can't hold its locks
   * for good. It must outlast the slowest wait inside an action: the browser's (2.5 minutes)
   * and the pacing between page loads (up to a minute).
   */
  idleInTransactionMs?: number;
}

export const POOL_DEFAULTS = {
  min: 2,
  statementTimeoutMs: 60_000,
  idleInTransactionMs: 5 * 60_000,
  /** How long an idle connection is kept above `min`. */
  idleMs: 5 * 60_000,
  /** How long to wait for a connection, new or from a full pool, before failing. */
  connectMs: 10_000,
} as const;

export function connect(url: string, options: ConnectOptions = {}): Database {
  const max = options.max ?? 10;
  // Set per connection when it opens (not with ALTER ROLE), so psql, pg_dump and pg_restore
  // keep the server's own defaults.
  const statementTimeout = options.statementTimeoutMs ?? POOL_DEFAULTS.statementTimeoutMs;
  const idleInTransaction = options.idleInTransactionMs ?? POOL_DEFAULTS.idleInTransactionMs;
  const pool = new pg.Pool({
    connectionString: url,
    max,
    min: Math.min(options.min ?? POOL_DEFAULTS.min, max),
    idleTimeoutMillis: POOL_DEFAULTS.idleMs,
    connectionTimeoutMillis: POOL_DEFAULTS.connectMs,
    // A connection that went dead without a goodbye (sleep, a network change) is noticed
    // instead of hanging the next query.
    keepAlive: true,
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
    ...(idleInTransaction > 0 ? { idle_in_transaction_session_timeout: idleInTransaction } : {}),
  });
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
