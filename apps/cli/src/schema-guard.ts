// Hearth's server, worker and Jarvis won't run against a database that doesn't fit their code
// (D57). A missed or failed migration then shows up as one clear line in the service log and a
// failing health report, instead of odd errors later. `hearth dev` migrates first, so it's exempt.
import {
  type MigrationState,
  migrationState,
  type SqlRunner,
  schemaMismatch,
  setting,
} from "@hearth/db";
import { type Kernel, systemCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";

export type Service = "server" | "worker" | "jarvis";

/** Errors that mean Postgres is still starting (at boot it can come up after Hearth). */
function starting(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e.code === "ECONNREFUSED" ||
    e.code === "57P03" ||
    /starting up|ECONNREFUSED/.test(String(e.message ?? ""))
  );
}

/** The migration state, waiting up to `waitMs` for Postgres to accept connections. */
export async function stateOnceUp(
  pool: SqlRunner,
  waitMs = 60_000,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<MigrationState> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await migrationState(pool);
    } catch (err) {
      if (!starting(err)) throw err;
      // A refused connection comes as an AggregateError with no message: say it in words, or
      // the service log gets an empty line.
      if (Date.now() >= deadline)
        throw new Error(
          `Can't reach the database (${(err as { code?: string }).code ?? "still starting"}) after ${Math.round(waitMs / 1000)} seconds. Is PostgreSQL running?`,
        );
      await sleep(2_000);
    }
  }
}

/** Null when the service may start; otherwise why not, already reported as failing. */
export async function guardSchema(
  service: Service,
  pool: SqlRunner,
  kernel: Kernel,
  waitMs?: number,
): Promise<string | null> {
  const why = schemaMismatch(await stateOnceUp(pool, waitMs));
  const report = (status: "ok" | "failing", detail: string) =>
    kernel
      .execute("system.report", { component: service, status, detail }, systemCaller())
      .catch(() => {});
  if (why) {
    await report("failing", `Won't start: ${why}`);
    return `Hearth's ${service} won't start. ${why}`;
  }
  // The worker and Jarvis report themselves every minute; the server doesn't, so clear an earlier
  // refusal here or it would stay failing.
  if (service === "server") {
    const [row] = await kernel.db.select().from(setting).where(eq(setting.key, "health.server"));
    if (row && (row.value as { status: string }).status !== "ok") await report("ok", "Running");
  }
  return null;
}
