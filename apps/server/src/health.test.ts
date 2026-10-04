import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jarvisTurn, loadMigrations } from "@hearth/db";
import { systemCaller } from "@hearth/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type { DeepHealth } from "./deep-health.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer | null = null;
let dist: string | null = null;
afterEach(async () => {
  await t?.destroy();
  if (dist) await rm(dist, { recursive: true, force: true });
  t = null;
  dist = null;
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** A request as a program on this PC sends it: straight to 127.0.0.1, not through a proxy. */
function local(s: TestServer, headers: Record<string, string> = {}, from = "127.0.0.1") {
  return s.server.app.request(
    "/api/health/deep",
    { headers: { host: "127.0.0.1:4400", ...headers } },
    { incoming: { socket: { remoteAddress: from } } },
  );
}

async function webDist(migrations = loadMigrations().map((m) => m.name)) {
  dist = await mkdtemp(join(tmpdir(), "hearth-dist-"));
  const stamp = { sha: SHA, builtAt: "2026-10-04T12:00:00.000Z", migrations };
  await writeFile(join(dist, "version.json"), JSON.stringify(stamp));
  return dist;
}

describe("deep health", () => {
  it("answers programs on this PC and you, nobody else", async () => {
    t = await createTestServer();
    expect((await local(t)).status).toBe(200);
    expect((await local(t, {}, "::ffff:127.0.0.1")).status).toBe(200);
    // Through Tailscale Serve, or any proxy: it says whom it forwards for.
    expect((await local(t, { "x-forwarded-for": "100.64.0.2" })).status).toBe(401);
    expect((await local(t, { "tailscale-user-login": "me@example.com" })).status).toBe(401);
    // A web page that pointed its own name at 127.0.0.1.
    expect((await local(t, { host: "evil.example:4400" })).status).toBe(401);
    expect((await local(t, {}, "100.64.0.2")).status).toBe(401);
    // Signed out, from anywhere else.
    expect((await t.browser("/api/health/deep")).status).toBe(401);
    // The bare health check stays open.
    expect(await (await t.browser("/api/health")).json()).toEqual({ ok: true });

    await t.destroy();
    t = await createTestServer({ devAuth: true });
    expect((await t.browser("/api/health/deep")).status).toBe(200);
  });

  it("reports the build it started with and whether the database fits it", async () => {
    t = await createTestServer({ webDist: await webDist() });
    await t.kernel.execute(
      "system.report",
      { component: "worker", status: "ok", detail: "Running" },
      systemCaller(),
    );
    const report = (await (await local(t)).json()) as DeepHealth;
    expect(report).toMatchObject({
      status: "ok",
      problems: [],
      sha: SHA,
      build: SHA,
      db: { ok: true },
      migrations: { ok: true, missing: [], unknown: [] },
      components: { worker: { status: "ok", stale: false } },
      jarvisTurns24h: { total: 0, failed: 0, last: null },
      browser: { connected: false },
    });
    expect(report.migrations?.applied).toBe(loadMigrations().length);

    const last = loadMigrations().at(-1)!.name;
    await t.tdb.pool.query("DELETE FROM _migration WHERE name = $1", [last]);
    const behind = (await (await local(t)).json()) as DeepHealth;
    expect(behind).toMatchObject({ status: "failing", migrations: { ok: false, missing: [last] } });
    expect(behind.problems[0]).toMatch(/missing 1 update/);
  });

  it("fails a component that stopped reporting, and notes Jarvis's failed turns", async () => {
    t = await createTestServer();
    await t.kernel.execute(
      "system.report",
      { component: "worker", status: "ok", detail: "Running" },
      systemCaller(),
    );
    const turn = (status: "done" | "failed", minutesAgo: number) => ({
      id: randomUUID(),
      trigger: "chat" as const,
      mode: "reactive" as const,
      lane: "fast" as const,
      origin: "owner" as const,
      prompt: "hi",
      status,
      error: status === "failed" ? "400 tools.124: invalid pattern\nstack..." : null,
      finishedAt: new Date(t!.clock.now().getTime() - minutesAgo * 60_000),
    });
    await t.kernel.db
      .insert(jarvisTurn)
      .values([turn("done", 60 * 30), turn("done", 90), turn("failed", 10)]);
    t.clock.advance(5 * 60_000);

    const report = (await (await local(t)).json()) as DeepHealth;
    expect(report.status).toBe("failing");
    expect(report.components.worker).toMatchObject({ status: "failing", stale: true });
    expect(report.problems).toContain("worker: No report for 5 min (last: Running).");
    expect(report.jarvisTurns24h).toMatchObject({
      total: 2,
      failed: 1,
      last: { status: "failed", error: "400 tools.124: invalid pattern" },
    });
    expect(report.problems.some((p) => p.startsWith("Jarvis's last turn failed"))).toBe(true);
  });

  it("notices a web build from other code than the server's", async () => {
    t = await createTestServer({ webDist: await webDist(["0001_foundations"]) });
    const report = (await (await local(t)).json()) as DeepHealth;
    expect(report.status).toBe("degraded");
    expect(report.problems[0]).toMatch(/built from other code/);
  });
});
