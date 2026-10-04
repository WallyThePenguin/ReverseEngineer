import { event, notification } from "@hearth/db";
import { setSetting, systemCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHealth, reportHealth } from "./health.ts";
import { jarvisWatchdog } from "./jarvis-watchdog.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

const checkIn = () =>
  setSetting(t.kernel.db, "jarvis.alive", {
    at: t.clock.now().toISOString(),
    since: t.clock.now().toISOString(),
    pid: 1234,
  });
const alerts = () => t.kernel.db.select().from(notification);

describe("the Jarvis watchdog", () => {
  it("restarts Jarvis once it's been quiet three minutes, and tells you", async () => {
    let restarts = 0;
    const check = jarvisWatchdog(t.kernel, {
      enabled: true,
      restart: async () => {
        restarts++;
      },
    });
    expect(await check()).toBe("never");
    await checkIn();
    t.clock.advance(2 * 60_000);
    expect(await check()).toBe("ok");
    t.clock.advance(2 * 60_000);
    expect(await check()).toBe("restarted");
    expect(restarts).toBe(1);
    expect(await alerts()).toMatchObject([
      { title: "Jarvis stopped, so Hearth restarted it", urgency: "normal" },
    ]);

    // Not again straight away.
    t.clock.advance(60_000);
    expect(await check()).toBe("waiting");
    // Still down after the gap: try again, and this time push it to you.
    t.clock.advance(15 * 60_000);
    expect(await check()).toBe("restarted");
    expect(restarts).toBe(2);
    const stuck = (await alerts()).find((a) => a.title === "Jarvis won't stay running");
    expect(stuck).toMatchObject({ urgency: "interrupt" });
    expect(stuck?.deliveredAt).not.toBeNull();

    // Back, then down again later: a new outage gets its own alert.
    await checkIn();
    expect(await check()).toBe("ok");
    t.clock.advance(20 * 60_000);
    expect(await check()).toBe("restarted");
    expect((await alerts()).filter((a) => a.title.startsWith("Jarvis stopped"))).toHaveLength(2);
  });

  it("says so when Windows won't run the task", async () => {
    const check = jarvisWatchdog(t.kernel, {
      enabled: true,
      restart: async () => {
        throw new Error("Access is denied.");
      },
    });
    await checkIn();
    t.clock.advance(4 * 60_000);
    expect(await check()).toBe("failed");
    expect(await alerts()).toMatchObject([{ title: "Jarvis won't stay running" }]);
  });

  it("sends what was held overnight when Jarvis is still down in the morning", async () => {
    t.clock.set("2026-10-02T03:00:00Z"); // 11 p.m.
    await checkIn();
    const held = await t.kernel.execute<{ id: string; delivered: boolean }>(
      "inbox.notify",
      { kind: "system.alert", title: "Jarvis won't stay running", urgency: "interrupt" },
      systemCaller(),
    );
    expect(held).toMatchObject({ status: "ok", result: { delivered: false } });
    const check = jarvisWatchdog(t.kernel, { enabled: false });
    // Still night: it waits.
    t.clock.advance(10 * 60_000);
    expect(await check()).toBe("off");
    expect((await alerts())[0]?.deliveredAt).toBeNull();
    // Morning, and nothing has checked in: the worker sends it, once.
    t.clock.set("2026-10-02T12:01:00Z");
    await check();
    await check();
    expect((await alerts())[0]?.deliveredAt).not.toBeNull();
    const sent = await t.kernel.db
      .select()
      .from(event)
      .where(eq(event.kind, "notification.delivered"));
    expect(sent).toHaveLength(1);
  });

  it("only watches outside the installed Windows worker", async () => {
    let restarts = 0;
    const check = jarvisWatchdog(t.kernel, {
      restart: async () => {
        restarts++;
      },
    });
    await checkIn();
    t.clock.advance(10 * 60_000);
    // Tests never run as the installed service, so the real task is never touched.
    expect(await check()).toBe("off");
    expect(restarts).toBe(0);
  });
});

describe("Jarvis's liveness in the health check", () => {
  it("goes by Jarvis's check-in, even while its turns are failing", async () => {
    await checkIn();
    await t.kernel.execute(
      "system.report",
      { component: "jarvis", status: "failing", detail: "A turn failed" },
      systemCaller(),
    );
    t.clock.advance(10 * 60_000);
    await reportHealth(t.kernel, await checkHealth(t.kernel, { dataDir: process.cwd() }));
    const down = await alerts();
    expect(down).toMatchObject([{ title: "Jarvis is down" }]);
    expect(down[0]?.body).toContain("hasn't checked in since");

    // A second outage the same day is told too.
    await checkIn();
    t.clock.advance(10 * 60_000);
    await reportHealth(t.kernel, await checkHealth(t.kernel, { dataDir: process.cwd() }));
    expect(await alerts()).toHaveLength(2);
  });
});
