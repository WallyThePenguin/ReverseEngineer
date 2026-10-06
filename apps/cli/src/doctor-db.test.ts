import { randomUUID } from "node:crypto";
import {
  connect,
  jarvisTurn,
  loadMigrations,
  slackBot,
  slackInbound,
  slackOutbox,
  slackWorkspace,
} from "@hearth/db";
import { setSetting, systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { deepHealth } from "@hearth/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "./doctor.ts";
import { checkDatabase, checkTurns } from "./doctor-db.ts";
import { checkSlackBot } from "./doctor-slack.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

const find = (checks: Check[], name: string) => checks.find((c) => c.name === name);

describe("hearth doctor, what the database says", () => {
  it("fails a component that went quiet, even if its last word was ok", async () => {
    await t.kernel.execute(
      "system.report",
      { component: "worker", status: "ok", detail: "Running" },
      systemCaller(),
    );
    const fresh = await checkDatabase(t.tdb, t.clock.now());
    expect(find(fresh, "Database")?.mark).toBe("ok");
    expect(find(fresh, "Migrations")).toMatchObject({ mark: "ok" });
    expect(find(fresh, "worker")?.mark).toBe("ok");
    expect(find(fresh, "backup")?.mark).toBe("warn");

    t.clock.advance(10 * 60_000);
    const later = await checkDatabase(t.tdb, t.clock.now());
    expect(find(later, "worker")).toMatchObject({
      mark: "fail",
      detail: "No report for 10 min (last: Running).",
    });
  });

  it("fails Chrome's link when the server stopped reporting it", async () => {
    // The server reports it every 5 minutes; when the server is down, its last "Connected"
    // mustn't stay green next to the Server failure.
    await t.kernel.execute(
      "system.report",
      { component: "browser", status: "ok", detail: "Connected (extension 1.2.0)" },
      systemCaller(),
    );
    t.clock.advance(9 * 60_000);
    expect(find(await checkDatabase(t.tdb, t.clock.now()), "browser")?.mark).toBe("ok");
    t.clock.advance(2 * 60_000);
    expect(find(await checkDatabase(t.tdb, t.clock.now()), "browser")).toMatchObject({
      mark: "fail",
      detail: "No report for 11 min (last: Connected (extension 1.2.0)).",
    });
  });

  it("warns about Jarvis's Slack socket, never fails on it, so Slack's trouble can't roll an update back (D62)", async () => {
    const report = (component: string, status: string, detail: string) =>
      t.kernel.execute("system.report", { component, status, detail }, systemCaller());
    const revoked = "Jarvis in Acme: Jarvis's Slack tokens were revoked.";
    await report("worker", "ok", "Running");
    await report("sync.slack_bot", "failing", revoked);
    expect(find(await checkDatabase(t.tdb, t.clock.now()), "sync.slack_bot")).toMatchObject({
      mark: "warn",
      detail: revoked,
    });
    const deep = () =>
      deepHealth({
        db: t.tdb.db,
        now: t.clock.now(),
        version: null,
        startedAt: null,
        browser: null,
      });
    const told = await deep();
    expect(told.status).toBe("degraded");
    expect(told.problems).toEqual([`sync.slack_bot: ${revoked}`]);
    expect(told.components["sync.slack_bot"]).toMatchObject({ status: "failing", external: true });
    // Hearth's own syncs still fail as before.
    await report("sync.slack", "failing", "Acme: invalid_auth");
    expect((await deep()).status).toBe("failing");
    expect(find(await checkDatabase(t.tdb, t.clock.now()), "sync.slack")?.mark).toBe("fail");
  });

  it("says what Jarvis's Slack bot did in the last day, and warns about posts that didn't go out (D62)", async () => {
    const now = t.clock.now();
    expect(await checkSlackBot(t.tdb.db, now)).toBeNull();
    await t.tdb.db.insert(slackWorkspace).values({
      teamId: "T1",
      teamName: "Acme",
      url: "https://acme.slack.com/",
      userId: "UME",
      token: "sealed",
    });
    await t.tdb.db.insert(slackBot).values({
      teamId: "T1",
      appId: "A0JARVIS",
      botUserId: "UJARVIS",
      botId: "B1",
      ownerIm: "DUME",
      installId: "this-pc",
      botToken: "sealed",
      appToken: "sealed",
    });
    await setSetting(t.tdb.db, "slack.bot.membersOn", true);
    const took = (ts: string, outcome: string, hoursAgo = 1) => ({
      channelId: "DSAM",
      ts,
      teamId: "T1",
      userId: "USAM",
      channelType: "im",
      source: "event" as const,
      takenAt: new Date(now.getTime() - hoursAgo * 3_600_000),
      outcome,
    });
    await t.tdb.db
      .insert(slackInbound)
      .values([
        took("1.1", "answered"),
        took("1.2", "answered"),
        took("1.3", "relayed"),
        { ...took("1.4", "yours"), channelId: "DUME", userId: "UME" },
        took("1.5", "answered", 30),
      ]);
    const line =
      "People in your Slack can talk to it; in the last 24 hours it answered 2, passed 1 on to you, and took 1 from you.";
    expect(await checkSlackBot(t.tdb.db, now)).toEqual({
      name: "Jarvis's Slack bot",
      mark: "ok",
      detail: line,
    });
    await t.tdb.db.insert(slackOutbox).values({
      id: randomUUID(),
      dedupeKey: "answer:lost",
      teamId: "T1",
      channelId: "DSAM",
      text: "Hi",
      kind: "answer",
      createdBy: "jarvis",
      state: "failed",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    expect(await checkSlackBot(t.tdb.db, now)).toMatchObject({
      mark: "warn",
      detail: `${line.slice(0, -1)}. 1 post(s) didn't go out: they're in your inbox.`,
    });
    // Slack revoking the bot is a warning, never a fail: an update can't fix it.
    await t.tdb.db.update(slackBot).set({ syncState: "revoked" });
    expect(await checkSlackBot(t.tdb.db, now)).toMatchObject({ mark: "warn" });
    expect(find(await checkDatabase(t.tdb, now), "Jarvis's Slack bot")?.mark).toBe("warn");
  });

  it("fails when Jarvis's turns keep failing", async () => {
    const turn = (status: "done" | "failed") => ({
      id: randomUUID(),
      trigger: "chat" as const,
      mode: "reactive" as const,
      lane: "fast" as const,
      origin: "owner" as const,
      prompt: "hi",
      status,
      error: status === "failed" ? "400 tools.124: invalid pattern" : null,
      // The failure is the latest.
      finishedAt: new Date(t.clock.now().getTime() - (status === "failed" ? 1 : 5) * 60_000),
    });
    await t.kernel.db.insert(jarvisTurn).values([turn("done"), turn("done"), turn("failed")]);
    const checks = await checkDatabase(t.tdb, t.clock.now());
    expect(find(checks, "Jarvis turns")).toMatchObject({
      mark: "fail",
      detail:
        "1 of 3 failed in the last 24 hours. Last error: 400 tools.124: invalid pattern Failures in 48 hours: chat/unknown x1.",
    });
  });

  it("stops at migrations that don't fit the code", async () => {
    const last = loadMigrations().at(-1)!.name;
    await t.tdb.pool.query("DELETE FROM _migration WHERE name = $1", [last]);
    const checks = await checkDatabase(t.tdb, t.clock.now());
    expect(checks.at(-1)).toMatchObject({ name: "Migrations", mark: "fail" });
    expect(checks.at(-1)?.detail).toContain(last);
  });

  it("says why it can't connect when Postgres isn't running", async () => {
    const nowhere = connect("postgres://hearth@localhost:1/hearth", { max: 1 });
    try {
      const [check] = await checkDatabase(nowhere, t.clock.now());
      expect(check).toMatchObject({ name: "Database", mark: "fail" });
      expect(check?.detail).toMatch(/^Can't connect: .*ECONNREFUSED/);
    } finally {
      await nowhere.close();
    }
  });

  it("judges a day of turns: a few failures warn, many fail", () => {
    const stats = (total: number, failed: number) => ({ total, failed, last: null });
    expect(checkTurns(stats(0, 0)).mark).toBe("ok");
    expect(checkTurns(stats(40, 0)).mark).toBe("ok");
    expect(checkTurns(stats(40, 2)).mark).toBe("warn");
    expect(checkTurns(stats(40, 5)).mark).toBe("fail");
  });

  it("says which turns failed and how, from counts alone", () => {
    const check = checkTurns({
      total: 5,
      failed: 2,
      last: null,
      failures48h: [
        { trigger: "routine", routine: "heartbeat", errorKind: "timeout", n: 2 },
        { trigger: "chat", routine: null, errorKind: null, n: 1 },
      ],
    });
    expect(check.detail).toBe(
      "2 of 5 failed in the last 24 hours. Failures in 48 hours: heartbeat/timeout x2, chat/unknown x1.",
    );
  });
});
