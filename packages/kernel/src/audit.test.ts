// What the audit log keeps (D56), and how failures are worded: your own reads leave no row,
// everything an agent or integration does still does, and no failure carries a query's values.
import { audit } from "@hearth/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { integrationCaller, jarvisCaller, ownerCaller } from "./callers.ts";
import { DATABASE_DOWN, describeError, isDatabaseDown, logLine } from "./errors.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";
import { defineAction, defineModule } from "./types.ts";

const probe = defineModule({
  name: "peek",
  description: "Test module",
  entityTypes: [],
  events: [],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    defineAction({
      name: "peek.look",
      description: "Reads something",
      input: z.object({}),
      risk: "read",
      handler: async () => ({ seen: true }),
    }),
    defineAction({
      name: "peek.both",
      description: "Reads, and asks another read",
      input: z.object({}),
      risk: "internal",
      handler: async (_i, ctx) => ctx.call("peek.look", {}),
    }),
    defineAction({
      name: "peek.broken",
      description: "A read that fails in the database",
      input: z.object({ secret: z.string() }),
      risk: "read",
      async handler(input) {
        // The shape Drizzle gives: its own message with the values, Postgres's reason inside.
        throw Object.assign(new Error(`Failed query: select $1\nparams: ${input.secret}`), {
          query: "select $1",
          cause: Object.assign(new Error('relation "nope" does not exist'), {
            code: "42P01",
            severity: "ERROR",
          }),
        });
      },
    }),
  ],
});

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([probe]);
});
afterAll(() => t.destroy());

const rows = (action: string) => t.tdb.db.select().from(audit).where(eq(audit.action, action));

describe("the audit log", () => {
  it("keeps no row for your own reads, but does for Jarvis's and an integration's", async () => {
    expect(await t.kernel.execute("peek.look", {}, ownerCaller())).toMatchObject({ status: "ok" });
    expect(await t.kernel.execute("peek.look", {}, ownerCaller("cli"))).toMatchObject({
      status: "ok",
    });
    expect(await rows("peek.look")).toHaveLength(0);

    await t.kernel.execute("peek.look", {}, jarvisCaller("owner"));
    await t.kernel.execute("peek.look", {}, integrationCaller("google"));
    // A paired device acts as you but under outside rules, so it's kept too.
    await t.kernel.execute("peek.look", {}, ownerCaller("device", { origin: "untrusted" }));
    const kept = await rows("peek.look");
    expect(kept.map((r) => r.principal).sort()).toEqual(["integration:google", "jarvis", "owner"]);
  });

  it("applies the same rule to reads one action asks of another", async () => {
    await t.kernel.execute("peek.both", {}, ownerCaller());
    expect(await rows("peek.both")).toHaveLength(1);
    const before = (await rows("peek.look")).length;
    await t.kernel.execute("peek.both", {}, jarvisCaller("owner"));
    expect((await rows("peek.look")).length).toBe(before + 1);
  });

  it("keeps a failed read of yours, worded without the values it carried", async () => {
    const res = await t.kernel.execute("peek.broken", { secret: "hunter2" }, ownerCaller());
    expect(res).toEqual({
      status: "error",
      code: "failed",
      message: 'relation "nope" does not exist (42P01)',
    });
    const [row] = await rows("peek.broken");
    expect(row).toMatchObject({
      outcome: "error",
      error: 'relation "nope" does not exist (42P01)',
    });
    expect(JSON.stringify(row)).not.toContain("params");
  });
});

describe("failure wording", () => {
  const pgError = (code: string, message = "x") =>
    Object.assign(new Error(message), { code, severity: "FATAL" });

  it("tells a database that's out of reach from one that refused the query", () => {
    expect(isDatabaseDown(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(
      true,
    );
    expect(isDatabaseDown(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseDown(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isDatabaseDown(pgError("57P01", "terminating connection"))).toBe(true);
    expect(isDatabaseDown(pgError("53300", "too many clients"))).toBe(true);
    // Wrapped by the ORM, it's still found.
    expect(isDatabaseDown(new Error("Failed query", { cause: pgError("08006") }))).toBe(true);
    expect(isDatabaseDown(pgError("23505", "duplicate key"))).toBe(false);
    // A bare code that only looks like Postgres's isn't taken as one.
    expect(isDatabaseDown(Object.assign(new Error("x"), { code: "08001" }))).toBe(false);
    expect(describeError(pgError("57P03"))).toEqual({
      code: "unavailable",
      message: DATABASE_DOWN,
    });
  });

  it("doesn't blame the database when another site can't be reached", () => {
    // Node's fetch, offline or with the site down: the network code is the site's, not ours.
    const offline = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), {
        code: "ENOTFOUND",
      }),
    });
    expect(isDatabaseDown(offline)).toBe(false);
    expect(describeError(offline)).toEqual({ code: "failed", message: "fetch failed" });
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(isDatabaseDown(refused)).toBe(false);
  });

  it("leaves out a value Postgres couldn't read", () => {
    const bad = new Error("Failed query: select $1\nparams: hunter2", {
      cause: Object.assign(new Error('invalid input syntax for type uuid: "hunter2"'), {
        code: "22P02",
        severity: "ERROR",
      }),
    });
    expect(describeError(bad).message).toBe("invalid input syntax for type uuid (22P02)");
  });

  it("drops a failed query's values from messages and logs", () => {
    const err = new Error('Failed query: insert into "vault" values ($1)\nparams: s3cret');
    expect(describeError(err).message).toBe('Failed query: insert into "vault" values ($1)');
    const wrapped = Object.assign(new Error("Failed query: x\nparams: s3cret"), {
      query: "update session set x = $1",
      cause: Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" }),
    });
    expect(logLine(wrapped)).toBe("deadlock detected (40P01) [query: update session set x = $1]");
    expect(logLine(wrapped)).not.toContain("s3cret");
  });
});
