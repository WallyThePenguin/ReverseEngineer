import { loadMigrations, type SqlRunner, setting } from "@hearth/db";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardSchema, stateOnceUp } from "./schema-guard.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

const health = async (component: string) => {
  const [row] = await t.kernel.db
    .select()
    .from(setting)
    .where(eq(setting.key, `health.${component}`));
  return row?.value as { status: string; detail: string } | undefined;
};

describe("starting a service against the database", () => {
  it("starts when the database fits the code", async () => {
    expect(await guardSchema("worker", t.tdb.pool, t.kernel)).toBeNull();
    expect(await health("worker")).toBeUndefined();
  });

  it("refuses, says why and reports failing when a migration is missing", async () => {
    const last = loadMigrations().at(-1)!.name;
    await t.tdb.pool.query("DELETE FROM _migration WHERE name = $1", [last]);
    const why = await guardSchema("server", t.tdb.pool, t.kernel);
    expect(why).toBe(
      `Hearth's server won't start. The database is missing 1 update(s) this code needs (${last}). Run \`hearth migrate\`.`,
    );
    expect(await health("server")).toMatchObject({ status: "failing" });
    expect((await health("server"))?.detail).toMatch(/^Won't start: /);

    // Once migrated, the server starts and clears its own failing report.
    await t.tdb.pool.query("INSERT INTO _migration (name) VALUES ($1)", [last]);
    expect(await guardSchema("server", t.tdb.pool, t.kernel)).toBeNull();
    expect(await health("server")).toMatchObject({ status: "ok", detail: "Running" });
  });

  it("refuses a database that's newer than the code", async () => {
    await t.tdb.pool.query("INSERT INTO _migration (name) VALUES ('9999_from_the_future')");
    expect(await guardSchema("jarvis", t.tdb.pool, t.kernel)).toMatch(/newer than the code/);
    expect(await health("jarvis")).toMatchObject({ status: "failing" });
  });

  it("waits for Postgres while it starts, but not for other errors", async () => {
    let refusals = 2;
    const booting: SqlRunner = {
      query: (text) => {
        if (refusals-- > 0)
          return Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
        return t.tdb.pool.query(text);
      },
    };
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    const state = await stateOnceUp(booting, 60_000, sleep);
    expect(state.missing).toEqual([]);
    expect(slept).toEqual([2_000, 2_000]);

    const wrongPassword: SqlRunner = {
      query: () => Promise.reject(Object.assign(new Error("password"), { code: "28P01" })),
    };
    await expect(stateOnceUp(wrongPassword, 60_000, sleep)).rejects.toThrow("password");
    expect(slept).toHaveLength(2);
  });
});
