// A request that throws gets a short JSON answer, a 503 when the database is out of reach, and
// nothing from the query that failed.
import { DATABASE_DOWN } from "@hearth/kernel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
beforeAll(async () => {
  t = await createTestServer({ devAuth: true });
  t.server.app.get("/boom/down", () => {
    throw new Error("Failed query: select 1", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      }),
    });
  });
  t.server.app.get("/boom/bug", () => {
    throw new Error('Failed query: insert into "vault" values ($1)\nparams: hunter2');
  });
});
afterAll(() => t.destroy());

describe("requests that fail", () => {
  it("answer 503 with a plain reason when the database is out of reach", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await t.browser("/boom/down");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({ error: DATABASE_DOWN });
    quiet.mockRestore();
  });

  it("answer 500 without the query's values, in the response or the log", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => logged.push(String(line)));
    const res = await t.browser("/boom/bug");
    spy.mockRestore();
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("hunter2");
    expect(JSON.parse(body)).toEqual({
      error: "Something went wrong in Nook. Try again in a moment.",
    });
    expect(logged.join("\n")).toContain("GET /boom/bug failed");
    // Where it broke, for fixing it.
    expect(logged.join("\n")).toMatch(/\n\s+at .*errors\.test\.ts/);
    expect(logged.join("\n")).not.toContain("hunter2");
  });

  it("ignores a correlation id that isn't a UUID instead of failing the action", async () => {
    const res = await t.browser("/api/actions/task.create", {
      method: "POST",
      headers: { "x-correlation-id": "not-a-uuid" },
      json: { title: "Still works" },
    });
    expect(res.status).toBe(200);
  });
});
