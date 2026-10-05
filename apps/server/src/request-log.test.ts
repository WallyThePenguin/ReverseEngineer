import { ownerCaller } from "@hearth/kernel";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "./env.ts";
import { requestLog } from "./request-log.ts";

function app(lines: string[]) {
  let t = 0;
  const a = new Hono<AppEnv>();
  a.use("*", requestLog({ log: (l) => lines.push(l), now: () => (t += 7) }));
  a.use("/me/*", async (c, next) => {
    c.set("caller", ownerCaller());
    await next();
  });
  a.get("/ok", (c) => c.text("ok"));
  a.get("/cached", (c) => c.body(null, 304));
  a.get("/me/missing", (c) => c.json({ error: "Not found." }, 404));
  a.get("/boom", () => {
    throw new Error("Failed query: select … params: secret");
  });
  a.onError((_err, c) => c.json({ error: "Something went wrong" }, 500));
  return a;
}

describe("request log", () => {
  it("logs answers outside 2xx with path, status, time and caller, never the query", async () => {
    const lines: string[] = [];
    const a = app(lines);
    await a.request("/ok?q=x");
    await a.request("/cached");
    await a.request("/me/missing?email=someone%40example.com");
    await a.request("/nowhere?token=abc", { method: "POST" });
    await a.request("/boom");
    expect(lines).toEqual([
      "[http] GET /me/missing 404 7 ms (owner)",
      "[http] POST /nowhere 404 7 ms (signed out)",
      "[http] GET /boom 500 7 ms (signed out)",
    ]);
    expect(lines.join("\n")).not.toMatch(/email|token|secret/);
  });
});
