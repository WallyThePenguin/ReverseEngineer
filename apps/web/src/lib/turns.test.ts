import { describe, expect, it } from "vitest";
import { plainReply, turnResult } from "./turns.ts";

describe("a turn in plain words", () => {
  it("drops markdown's marks and runs the lines together", () => {
    expect(plainReply("**Offsite prep** is ready.\n\n- Book the room\n- Tell `Leo`")).toBe(
      "Offsite prep is ready. Book the room Tell Leo",
    );
  });

  it("says how it ended, never the stored code", () => {
    expect(turnResult({ status: "done", outcome: "ask" })).toBe("Asked you");
    expect(turnResult({ status: "done", outcome: "nothing" })).toBe("Nothing to do");
    expect(turnResult({ status: "done", outcome: null })).toBe("Done");
    expect(turnResult({ status: "canceled", outcome: null })).toBe("Stopped");
    expect(turnResult({ status: "skipped", outcome: null })).toBe("Skipped");
  });
});
