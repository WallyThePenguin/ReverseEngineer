// Deciding from the app: a double tap sends one decision, a decided approval's buttons stay
// gone, and only Hearth being out of reach leaves it to decide again (D58). Always allow is the
// yes with its rule: Hearth writes the rule only when the yes goes through, and you're told when
// it didn't (D70).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shown: { text: string; tone: string }[] = [];
vi.mock("./live.ts", () => ({
  live: { refresh: () => {}, connected: () => false },
  toast: { show: (text: string, tone = "info") => shown.push({ text, tone }) },
  queryClient: {},
  reportError: (err: Error) => shown.push({ text: err.message, tone: "error" }),
}));

const eng = { action: "slack.post_in_channel", target: "C1", note: "posting in #eng" };

const {
  alwaysAllow,
  alwaysAllowWords,
  approvalStateText,
  decide,
  decideQuietly,
  decidedAs,
  deciding,
  isDecided,
  isWaiting,
  ruleWords,
  settledAs,
} = await import("./approvals.ts");

let calls = 0;
const paths: string[] = [];
const sent: unknown[] = [];
function reply(status: number, body: unknown, wait = 0) {
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    calls++;
    paths.push(path);
    sent.push(JSON.parse(String(init?.body ?? "null")));
    await new Promise((r) => setTimeout(r, wait));
    return new Response(JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  calls = 0;
  paths.length = 0;
  sent.length = 0;
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
    expect(shown).toEqual([{ text: "Approved and done.", tone: "ok" }]);
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
    const quietly = async (id: string) => (await decideQuietly(id, "approve")).outcome;
    reply(200, { status: "ok", result: {} });
    expect(await decideQuietly("b1", "approve")).toEqual({ outcome: "done", message: null });
    // Decided a moment ago: not the one Approve all saw waiting.
    expect(await quietly("b1")).toBe("changed");
    reply(409, { status: "error", code: "conflict", message: "This was already denied." });
    expect(await quietly("b2")).toBe("changed");
    const changed = "The draft changed since you were asked, so nothing was sent.";
    reply(400, { status: "error", code: "conflict", message: changed });
    // With Hearth's reason, for the line that reports them.
    expect(await decideQuietly("b3", "approve")).toEqual({ outcome: "changed", message: changed });
    expect(decidedAs("b3")).toBe("failed");
    reply(404, { status: "error", code: "not_found", message: "Approval not found" });
    expect(await quietly("b4")).toBe("changed");
    reply(502, { status: "error", code: "failed", message: "Gmail said no." });
    expect(await decideQuietly("b5", "approve")).toEqual({
      outcome: "failed",
      message: "Gmail said no.",
    });
    reply(503, { status: "error", code: "unavailable", message: "Hearth is busy." });
    expect(await quietly("b6")).toBe("failed");
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

  it("Always allow is one yes with its rule, once however often it's pressed", async () => {
    reply(200, { status: "ok", result: { rule: eng } }, 10);
    const first = alwaysAllow("c1");
    expect(deciding("c1")).toBe(true);
    await Promise.all([first, alwaysAllow("c1"), decide("c1", "deny")]);
    expect(paths).toEqual(["/api/approvals/c1"]);
    expect(sent).toEqual([{ decision: "approve", alwaysAllow: true }]);
    expect(decidedAs("c1")).toBe("executed");
    expect(shown).toEqual([
      { text: "Done. From now on, posting in #eng goes without asking.", tone: "ok" },
    ]);
    // A plain yes doesn't ask for a rule.
    reply(200, { status: "ok", result: {} });
    await decide("c9", "approve");
    expect(sent.at(-1)).toEqual({ decision: "approve" });
  });

  it("Always allow says what Hearth saved, and never that it saved one it didn't", async () => {
    // Pressed again after the first answer was lost: it was done, rule and all.
    reply(200, { status: "ok", result: { rule: eng, already: true } });
    expect(await alwaysAllow("c6")).toBe("done");
    // A yes that came back without its rule doesn't say it saved one.
    reply(200, { status: "ok", result: { sent: true } });
    expect(await alwaysAllow("c7")).toBe("done");
    expect(shown).toEqual([
      { text: "Already done. From now on, posting in #eng goes without asking.", tone: "ok" },
      { text: "Approved and done, but no rule was saved.", tone: "error" },
    ]);
  });

  it("Always allow says plainly that no rule was saved when the yes didn't go through", async () => {
    const no =
      "Always allow is only for what Jarvis asks in a conversation you started, so nothing was done.";
    reply(403, { status: "denied", reason: no });
    expect(await alwaysAllow("c2")).toBe("failed");
    // Still waiting for you: the card is read again, without the button an email's turn can't use.
    expect(isDecided("c2")).toBe(false);
    reply(409, { status: "error", code: "conflict", message: "This was already denied." });
    expect(await alwaysAllow("c3")).toBe("changed");
    expect(decidedAs("c3")).toBe("denied");
    const changed = "Who or where this goes changed since you were asked, so nothing was sent.";
    reply(409, { status: "error", code: "conflict", message: changed });
    expect(await alwaysAllow("c4")).toBe("changed");
    expect(shown).toEqual([
      { text: `${no} No rule was saved.`, tone: "error" },
      { text: "This was already denied. No rule was saved.", tone: "info" },
      { text: `${changed} No rule was saved.`, tone: "error" },
    ]);
  });

  it("Always allow doesn't claim no rule was saved when Hearth didn't answer", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await alwaysAllow("c5")).toBe("failed");
    expect(isDecided("c5")).toBe(false);
    expect(shown).toEqual([
      { text: "Can't reach Hearth right now. Try again in a moment.", tone: "error" },
    ]);
  });

  it("reads a rule for one channel, and one for any, in Settings", () => {
    const rule = { action: "slack.post_in_channel", target: "C1", note: "posting in #eng" };
    expect(ruleWords(rule)).toBe("Always allow posting in #eng");
    expect(ruleWords({ ...rule, target: null, note: "Team news" })).toBe("Team news · any channel");
    expect(ruleWords({ action: "slack.dm", target: null, note: "" })).toBe("anyone");
    expect(ruleWords({ action: "task.create", target: null, note: "Tasks" })).toBe("Tasks");
  });

  it("offers Always allow only on what Jarvis asked in a conversation you started", () => {
    const asked = {
      id: "d1",
      origin: "owner",
      requestedBy: "jarvis",
      alwaysAllow: { target: "C1", says: "posting in #eng" },
    } as Parameters<typeof alwaysAllowWords>[0];
    expect(alwaysAllowWords(asked)).toBe("posting in #eng");
    expect(alwaysAllowWords({ ...asked!, origin: "untrusted" })).toBeNull();
    expect(alwaysAllowWords({ ...asked!, origin: "system" })).toBeNull();
    expect(alwaysAllowWords({ ...asked!, requestedBy: "mcp:claude" })).toBeNull();
    expect(alwaysAllowWords({ ...asked!, alwaysAllow: null })).toBeNull();
  });

  it("names each state in a few words", () => {
    expect(approvalStateText("executing")).toBe("Being done…");
    expect(approvalStateText("expired")).toBe("Ran out before you decided");
    expect(approvalStateText("gone")).toBe("No longer waiting");
  });
});
