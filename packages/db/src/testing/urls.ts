import { createHash } from "node:crypto";

/**
 * The migrated database each test file clones. Named after the checkout, so test runs in two
 * worktrees against the same Postgres don't drop each other's template.
 */
export const TEMPLATE_DB = `hearth_test_template_${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8)}`;

/**
 * A server URL for tests; the database part is replaced per test. There's no default: on a PC
 * that also runs Hearth, localhost:5432 is the cluster holding your data, so tests only go where
 * HEARTH_TEST_DATABASE_URL says (README, "Tests").
 */
export function adminUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.HEARTH_TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      'Set HEARTH_TEST_DATABASE_URL to a Postgres just for tests (README, "Tests"); they never pick one themselves, so they can\'t reach the one holding your data.',
    );
  return url;
}

export function withDatabase(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(adminUrl(env));
  url.pathname = `/${name}`;
  return url.toString();
}
