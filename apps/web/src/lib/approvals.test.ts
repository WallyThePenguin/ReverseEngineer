// Deciding from the app: a double tap sends one decision, a decided approval's buttons stay
// gone, and only Hearth being out of reach leaves it to decide again (D58).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown: { text: string; tone: string }[] = [];
vi.mock("./live.ts", () => ({
  live: { refresh: () => {}, connected: () => false },
  toast: { show: (text: string, tone = "info") => shown.push({ text, tone }) },
}));

const { approvalStateText, decide, deciding, isDecided } = await import("./approvals.ts");

let calls = 0;
function reply(status: number, body: unknown, wait = 0) {
  vi.stubGlobal("fetch", async () => {
    calls++;
    await new Promise((r) => setTimeout(r, wait));
    return new Response(JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  calls = 0;
  shown.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("deciding an approval", () => {
  it("sends a double tap once, and keeps the buttons off while it's on its way", async () => {
    reply(200, { status: "ok", result: { sent: true } }, 20);
    const first = decide("a1", "approve");
    expect(deciding("a1")).toBe(true);
    await Promise.all([first, decide("a1", "approve"), decide("a1", "deny")]);
    expect(calls).toBe(1);
    expect(deciding("a1")).toBe(false);
    expect(isDecided("a1")).toBe(true);
    expect(shown).toEqual([{ text: "Approved and done.", tone: "info" }]);
    await decide("a1", "approve");
    expect(calls).toBe(1);
  });

  it("says plainly when another device got there first", async () => {
    reply(409, { status: "error", code: "conflict", message: "This was already denied." });
    await decide("a2", "approve");
    expect(isDecided("a2")).toBe(true);
    expect(shown).toEqual([{ text: "This was already denied.", tone: "info" }]);
  });

  it("leaves it to decide again when Hearth can't be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await decide("a3", "approve");
    expect(isDecided("a3")).toBe(false);
    expect(shown[0]?.tone).toBe("error");
    reply(503, { status: "error", code: "unavailable", message: "Hearth is busy." });
    await decide("a3", "approve");
    expect(isDecided("a3")).toBe(false);
  });

  it("names each state in a few words", () => {
    expect(approvalStateText("executing")).toBe("Being done…");
    expect(approvalStateText("expired")).toBe("Ran out before you decided");
  });
});
