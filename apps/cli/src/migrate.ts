// `hearth migrate [down [name]]`. What committed is printed even when a migration fails partway
// (on stdout; the error goes to stderr), so ops/windows/update.ps1 can revert exactly that.
import { type Database, MIGRATIONS_DIR, MigrationError, migrateDown, migrateUp } from "@hearth/db";

export async function migrateCommand(
  pool: Database["pool"],
  args: string[],
  log: (line: string) => void = console.log,
  dir = MIGRATIONS_DIR,
): Promise<number> {
  const down = args[0] === "down";
  const verb = down ? "Reverted" : "Applied";
  try {
    const names = down ? await migrateDown(pool, args[1] ?? 1, dir) : await migrateUp(pool, dir);
    if (names.length) log(`${verb}: ${names.join(", ")}`);
    else log(down ? "Nothing to revert." : "Up to date.");
    return 0;
  } catch (err) {
    if (err instanceof MigrationError && err.committed.length)
      log(`${verb}: ${err.committed.join(", ")}`);
    throw err;
  }
}
