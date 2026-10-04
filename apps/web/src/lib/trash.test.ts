// Restoring a record says what came back; and whenever anything comes back, restored here or
// anywhere else, the edits this device kept for a note deleted before they reached Hearth are
// sent then, rather than at the next start of Hearth in this browser (D59).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "./live.ts";

const calls = vi.hoisted(() => ({ restored: null as unknown, sent: 0, shown: [] as string[] }));
/** Who's listening to the live feed; the tests send its events. */
const feed = vi.hoisted(() => new Set<(e: LiveEvent) => void>());
vi.mock("./query.ts", () => ({ act: async () => calls.restored }));
vi.mock("./live.ts", () => ({
  toast: { show: (text: string) => calls.shown.push(text) },
  onLiveEvent: (fn: (e: LiveEvent) => void) => {
    feed.add(fn);
    return () => feed.delete(fn);
  },
}));
vi.mock("./docStore.ts", () => ({
  sendKeptNotes: async () => {
    calls.sent++;
  },
}));
const hear = (kind: string, entityId: string) => {
  for (const fn of feed) fn({ seq: 1, kind, entityId, actor: "jarvis", payload: {} });
};

const { restore, sendKeptOnRestore } = await import("./trash.ts");

beforeEach(() => {
  vi.useFakeTimers();
  calls.restored = null;
  calls.sent = 0;
  calls.shown = [];
  feed.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("restoring from the trash", () => {
  it("says what came back, and with it", async () => {
    calls.restored = { title: "Plan", withIt: 2 };
    expect(await restore("n1")).toBe(true);
    expect(calls.shown).toEqual(['Restored "Plan" and 2 records under it.']);
    calls.restored = null;
    expect(await restore("n1")).toBe(false);
  });

  it("sends kept edits once for restores close together, made anywhere", async () => {
    const stop = sendKeptOnRestore();
    // A record and what went to the trash with it come back, an event each.
    hear("entity.restored", "n1");
    hear("entity.restored", "n2");
    hear("entity.updated", "n3");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.sent).toBe(1);
    hear("entity.restored", "n4");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.sent).toBe(2);
    stop();
    hear("entity.restored", "n5");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.sent).toBe(2);
  });
});
