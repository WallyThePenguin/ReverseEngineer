import { createHash } from "node:crypto";

/**
 * The migrated database each test file clones. Named after the checkout, so test runs in two
 * worktrees against the same Postgres don't drop each other's template.
 */
export const TEMPLATE_DB = `hearth_test_template_${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8)}`;

/** A server URL for tests; the database part is replaced per test. */
export function adminUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEARTH_TEST_DATABASE_URL ?? "postgres://hearth:hearth@localhost:5432/postgres";
}

export function withDatabase(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(adminUrl(env));
  url.pathname = `/${name}`;
  return url.toString();
}
