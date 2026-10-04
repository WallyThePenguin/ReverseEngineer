// Vitest global setup: build a migrated template database once per run. Each test file then
// clones it (CREATE DATABASE ... TEMPLATE), which takes milliseconds. The template is dropped
// when the run ends, so nothing is left behind on the test server.
import pg from "pg";
import { migrateUp } from "../migrate.ts";
import { adminUrl, TEMPLATE_DB, withDatabase } from "./urls.ts";

async function asAdmin(sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  await asAdmin(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await asAdmin(`CREATE DATABASE ${TEMPLATE_DB}`);
  const pool = new pg.Pool({ connectionString: withDatabase(TEMPLATE_DB) });
  try {
    await migrateUp(pool);
  } finally {
    await pool.end();
  }
  return () => asAdmin(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
}
