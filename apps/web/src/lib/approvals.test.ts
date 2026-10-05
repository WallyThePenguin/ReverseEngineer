// Deciding from the app: a double tap sends one decision, a decided approval's buttons stay
// gone, and only Hearth being out of reach leaves it to decide again (D58).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown: { text: string; tone: string }[] = [];
vi.mock("./live.ts", () => ({
  live: { refresh: () => {}, connected: () => false },
  toast: { show: (text: string, tone = "info") => shown.push({ text, tone }) },
}));

const { approvalStateText, decide, decidedAs, deciding, isDecided, isWaiting, settledAs } =
  await import("./approvals.ts");

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
    expect(decidedAs("a1")).toBe("executed");
    expect(shown).toEqual([{ text: "Approved and done.", tone: "info" }]);
    await decide("a1", "approve");
    expect(calls).toBe(1);
  });

  it("says plainly when another device got there first", async () => {
    reply(409, { status: "error", code: "conflict", message: "This was already denied." });
    await decide("a2", "approve");
    expect(isDecided("a2")).toBe(true);
    // A yes that found it denied says it was denied, not that you approved it.
    expect(decidedAs("a2")).toBe("denied");
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
    expect(decidedAs("a3")).toBe(null);
  });

  it("stops waiting for you the moment it's decided here, before the lists catch up", async () => {
    expect(isWaiting("a4", "pending")).toBe(true);
    expect(isWaiting("a4", "executed")).toBe(false);
    reply(200, { status: "ok", result: {} });
    await decide("a4", "deny");
    expect(isWaiting("a4", "pending")).toBe(false);
    expect(decidedAs("a4")).toBe("denied");
    expect(shown).toEqual([{ text: "Denied.", tone: "info" }]);
  });

  it("says how each decision went, quietly when its caller reports them together", async () => {
    reply(200, { status: "ok", result: {} });
    expect(await decide("b1", "approve", { quiet: true })).toBe("done");
    // Decided a moment ago: not the one Approve all saw waiting.
    expect(await decide("b1", "approve", { quiet: true })).toBe("changed");
    reply(409, { status: "error", code: "conflict", message: "This was already denied." });
    expect(await decide("b2", "approve", { quiet: true })).toBe("changed");
    reply(400, {
      status: "error",
      code: "conflict",
      message: "The draft changed since you were asked, so nothing was sent.",
    });
    expect(await decide("b3", "approve", { quiet: true })).toBe("changed");
    expect(decidedAs("b3")).toBe("failed");
    reply(404, { status: "error", code: "not_found", message: "Approval not found" });
    expect(await decide("b4", "approve", { quiet: true })).toBe("changed");
    reply(502, { status: "error", code: "failed", message: "Gmail said no." });
    expect(await decide("b5", "approve", { quiet: true })).toBe("failed");
    reply(503, { status: "error", code: "unavailable", message: "Hearth is busy." });
    expect(await decide("b6", "approve", { quiet: true })).toBe("failed");
    expect(isDecided("b6")).toBe(false);
    expect(shown).toEqual([]);
    // Without quiet, the same answer is a toast.
    expect(await decide("b7", "approve")).toBe("failed");
    expect(shown).toEqual([{ text: "Hearth is busy.", tone: "error" }]);
  });

  it("reads what became of it from what Hearth said when it couldn't take the decision", () => {
    const conflict = (message: string) => ({ code: "conflict", message });
    expect(settledAs("deny", conflict("This was already approved and done."))).toBe("executed");
    expect(settledAs("approve", conflict("This was already denied."))).toBe("denied");
    expect(settledAs("deny", conflict("This was already approved, and it failed."))).toBe("failed");
    expect(settledAs("deny", conflict("This is already being done."))).toBe("executing");
    expect(settledAs("approve", conflict("This approval ran out before anyone decided."))).toBe(
      "expired",
    );
    // Approved, and then it couldn't run: that's a failure, not a yes that went through.
    expect(settledAs("approve", conflict("Hearth couldn't start this, so nothing was run."))).toBe(
      "failed",
    );
    expect(settledAs("deny", { code: "not_found", message: "Approval not found" })).toBe("gone");
  });

  it("names each state in a few words", () => {
    expect(approvalStateText("executing")).toBe("Being done…");
    expect(approvalStateText("expired")).toBe("Ran out before you decided");
    expect(approvalStateText("gone")).toBe("No longer waiting");
  });
});
