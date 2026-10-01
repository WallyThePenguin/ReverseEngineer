// Vitest global setup: build a migrated template database once per run. Each test file then
// clones it (CREATE DATABASE ... TEMPLATE), which takes milliseconds.
import pg from "pg";
import { migrateUp } from "../migrate.ts";
import { adminUrl, TEMPLATE_DB, withDatabase } from "./urls.ts";

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: withDatabase(TEMPLATE_DB) });
  try {
    await migrateUp(pool);
  } finally {
    await pool.end();
  }
}
