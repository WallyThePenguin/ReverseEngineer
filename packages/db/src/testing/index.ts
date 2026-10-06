// Per-test-file databases cloned from the migrated template.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { connect, type Database } from "../client.ts";
import { adminUrl, TEMPLATE_DB, withDatabase } from "./urls.ts";

export { budget, fastest } from "./timing.ts";
export { adminUrl, TEMPLATE_DB, withDatabase } from "./urls.ts";

export interface TestDatabase extends Database {
  url: string;
  name: string;
  /** Closes the pool and drops the database. */
  destroy(): Promise<void>;
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `hearth_test_${randomBytes(6).toString("hex")}`;
  await admin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`));
  const url = withDatabase(name);
  const database = connect(url, { max: 5 });
  return {
    ...database,
    url,
    name,
    async destroy() {
      await database.close();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
