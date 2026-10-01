export const TEMPLATE_DB = "hearth_test_template";

/** A server URL for tests; the database part is replaced per test. */
export function adminUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEARTH_TEST_DATABASE_URL ?? "postgres://hearth:hearth@localhost:5432/postgres";
}

export function withDatabase(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const url = new URL(adminUrl(env));
  url.pathname = `/${name}`;
  return url.toString();
}
