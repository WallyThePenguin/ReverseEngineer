// LISTEN rides through a dropped connection: it says so once, says when it's back, and tells
// the listener it's back so it can catch up on what was announced meanwhile.
import { createTestDatabase, type TestDatabase } from "@hearth/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listenChannels } from "./events.ts";

let tdb: TestDatabase;
beforeEach(async () => {
  tdb = await createTestDatabase();
});
afterEach(() => tdb.destroy());

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("listenChannels", () => {
  it("logs a lost connection once, logs its return, and says it's listening again", async () => {
    const got: string[] = [];
    const lines: string[] = [];
    const listening: boolean[] = [];
    const stop = listenChannels(tdb.pool, ["hearth_test"], (_ch, p) => got.push(p), {
      onListening: (again) => listening.push(again),
      log: (l) => lines.push(l),
    });
    await until(() => listening.length === 1);
    expect(listening).toEqual([false]);
    await tdb.pool.query("NOTIFY hearth_test, 'one'");
    await until(() => got.length === 1);

    // The database drops the connection (a restart, a network blip).
    await tdb.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND query LIKE 'LISTEN%' AND pid <> pg_backend_pid()`,
    );
    await until(() => listening.length === 2);
    expect(listening).toEqual([false, true]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[listen\] LISTEN hearth_test: connection lost \(/);
    expect(lines[1]).toMatch(/^\[listen\] LISTEN hearth_test: back after \d+ s$/);

    await tdb.pool.query("NOTIFY hearth_test, 'two'");
    await until(() => got.length === 2);
    expect(got).toEqual(["one", "two"]);
    await stop();
  });
});
