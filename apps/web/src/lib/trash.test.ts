// Restoring a record sends at once the edits this device kept for a note deleted before they
// reached Hearth, rather than at the next start of Hearth in this browser (D59).
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ restored: null as unknown, sent: 0, shown: [] as string[] }));
vi.mock("./query.ts", () => ({ act: async () => calls.restored }));
vi.mock("./live.ts", () => ({ toast: { show: (text: string) => calls.shown.push(text) } }));
vi.mock("./docStore.ts", () => ({
  sendKeptNotes: async () => {
    calls.sent++;
  },
}));

const { restore } = await import("./trash.ts");

beforeEach(() => {
  calls.restored = null;
  calls.sent = 0;
  calls.shown = [];
});

describe("restoring from the trash", () => {
  it("sends the edits kept for a deleted note once it's back", async () => {
    calls.restored = { title: "Plan", withIt: 0 };
    expect(await restore("n1")).toBe(true);
    expect(calls.shown).toEqual(['Restored "Plan".']);
    expect(calls.sent).toBe(1);
  });

  it("sends nothing when it didn't come back", async () => {
    expect(await restore("n1")).toBe(false);
    expect(calls.sent).toBe(0);
  });
});
