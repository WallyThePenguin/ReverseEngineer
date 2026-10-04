// How Jarvis's turns went lately, for `hearth doctor` (D54).
import { jarvisTurn } from "@hearth/db";
import { newId } from "@hearth/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { turnStats } from "./health.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
afterEach(() => h.destroy());

describe("turnStats", () => {
  it("counts the last day's turns by how they ended, and names the latest failure", async () => {
    h = await createJarvisHarness("2026-10-02T14:00:00Z");
    const at = (iso: string) => new Date(iso);
    const turn = (status: string, queued: string, extra: Record<string, unknown> = {}) => ({
      id: newId(),
      trigger: "chat" as const,
      mode: "reactive" as const,
      lane: "fast" as const,
      origin: "owner" as const,
      prompt: "hi",
      status: status as "done",
      queuedAt: at(queued),
      finishedAt: at(queued),
      ...extra,
    });
    await h.tdb.db.insert(jarvisTurn).values([
      // Two days ago: outside the window.
      turn("failed", "2026-09-30T14:00:00Z", { errorKind: "auth", error: "old" }),
      turn("done", "2026-10-02T09:00:00Z"),
      turn("done", "2026-10-02T10:00:00Z"),
      turn("failed", "2026-10-02T11:00:00Z", { errorKind: "overloaded", error: "529" }),
      turn("failed", "2026-10-02T12:00:00Z", { errorKind: "timeout", error: "too long" }),
      turn("skipped", "2026-10-02T13:00:00Z", { skipReason: "expired" }),
      // Cut short by a restart: not Jarvis failing, so not counted.
      turn("failed", "2026-10-02T13:30:00Z", { errorKind: "interrupted", error: "restart" }),
    ]);
    const stats = await turnStats(h.tdb.db, h.clock.now());
    expect(stats.byStatus).toEqual({ done: 2, failed: 2, skipped: 1 });
    expect(stats.failureRate).toBe(0.5);
    expect(stats.lastFailure).toMatchObject({
      kind: "timeout",
      error: "too long",
      trigger: "chat",
    });
  });

  it("reads as no failures when nothing ran", async () => {
    h = await createJarvisHarness("2026-10-02T14:00:00Z");
    expect(await turnStats(h.tdb.db, h.clock.now())).toMatchObject({
      byStatus: {},
      failureRate: 0,
      lastFailure: null,
    });
  });
});
