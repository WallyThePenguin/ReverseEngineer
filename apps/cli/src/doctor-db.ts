// `hearth doctor`, what the database says: migrations both ways, sign-in, every component's
// health judged by how fresh it is (a stale "ok" fails), and how Jarvis's turns went today.
import { credential, type Database, type MigrationState, migrationState } from "@hearth/db";
import { type DeepHealth, deepHealth, type TurnStats, whyFailed } from "@hearth/server";
import type { Check, Mark } from "./doctor.ts";

/** More than this share of the last day's turns failing is a fail; any failure is a warning. */
export const TURN_FAILURE_LIMIT = 0.1;

const MARK = { ok: "ok", degraded: "warn", failing: "fail" } as const;

export function checkMigrations(state: MigrationState): Check {
  if (state.missing.length)
    return {
      name: "Migrations",
      mark: "fail",
      detail: `${state.missing.length} not applied (${state.missing.join(", ")}). Run \`hearth migrate\`.`,
    };
  if (state.unknown.length)
    return {
      name: "Migrations",
      mark: "fail",
      detail: `The database has ${state.unknown.join(", ")}, which this code doesn't know: it's newer than the code. Update Hearth, or restore the dump taken before the last update.`,
    };
  return { name: "Migrations", mark: "ok", detail: `${state.expected.length} applied` };
}

export function checkTurns(turns: TurnStats): Check {
  const name = "Jarvis turns";
  if (!turns.total) return { name, mark: "ok", detail: "None in the last 24 hours" };
  const last = turns.last?.error ? ` Last error: ${turns.last.error}` : "";
  const share = turns.failed / turns.total;
  const detail = `${turns.failed} of ${turns.total} failed in the last 24 hours.${last}`;
  if (share > TURN_FAILURE_LIMIT) return { name, mark: "fail", detail };
  if (turns.failed) return { name, mark: "warn", detail };
  return { name, mark: "ok", detail: `${turns.total} in the last 24 hours, none failed` };
}

/** One check per health component, stale ones failing (D57), someone else's service warning. */
export function checkComponents(report: DeepHealth): Check[] {
  const checks: Check[] = [];
  if (!report.components.backup)
    checks.push({
      name: "backup",
      mark: "warn",
      detail: "No backup has run yet. See docs/setup-windows.md.",
    });
  for (const [name, h] of Object.entries(report.components)) {
    // Slack dropping Jarvis's socket is a warning, not a fail: an update can't fix it, so the
    // update's before-and-after doctor mustn't roll one back over it (D62).
    const mark: Mark = h.external && h.status === "failing" ? "warn" : MARK[h.status];
    checks.push({ name, mark, detail: h.detail || h.status });
  }
  return checks;
}

export async function checkDatabase(database: Database, now = new Date()): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    await database.pool.query("SELECT 1");
    checks.push({ name: "Database", mark: "ok", detail: "Connected" });
  } catch (err) {
    return [{ name: "Database", mark: "fail", detail: `Can't connect: ${whyFailed(err)}` }];
  }

  const state = await migrationState(database.pool);
  const migrations = checkMigrations(state);
  checks.push(migrations);
  if (migrations.mark === "fail") return checks;

  const passkeys = await database.db.select({ id: credential.id }).from(credential);
  checks.push(
    passkeys.length
      ? { name: "Login", mark: "ok", detail: `${passkeys.length} passkey(s)` }
      : { name: "Login", mark: "warn", detail: "No passkey yet. Run `hearth setup`." },
  );

  const report = await deepHealth({
    db: database.db,
    now,
    version: null,
    startedAt: null,
    browser: null,
  });
  checks.push(...checkComponents(report));
  if (report.jarvisTurns24h) checks.push(checkTurns(report.jarvisTurns24h));
  return checks;
}
