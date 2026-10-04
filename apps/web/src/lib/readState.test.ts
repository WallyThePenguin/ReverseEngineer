import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import { failedMessage, isMissing, retryRead } from "./readState.ts";

describe("read states", () => {
  it("calls only not_found missing", () => {
    expect(isMissing(new ApiError(400, "not_found", "Task not found"))).toBe(true);
    expect(isMissing(new ApiError(0, "unreachable", "Can't reach Hearth"))).toBe(false);
    expect(isMissing(new ApiError(400, "failed", "Boom"))).toBe(false);
    expect(isMissing(new Error("plain"))).toBe(false);
    expect(isMissing(null)).toBe(false);
  });

  it("retries once, and never an answer that won't change", () => {
    const down = new ApiError(0, "unreachable", "Can't reach Hearth");
    expect(retryRead(0, down)).toBe(true);
    expect(retryRead(1, down)).toBe(false);
    expect(retryRead(0, new ApiError(500, "failed", "Boom"))).toBe(true);
    expect(retryRead(0, new ApiError(400, "not_found", "Task not found"))).toBe(false);
    expect(retryRead(0, new ApiError(400, "invalid_input", "Bad id"))).toBe(false);
    expect(retryRead(0, new ApiError(403, "denied", "No"))).toBe(false);
  });

  it("says what failed in a sentence", () => {
    expect(
      failedMessage(new ApiError(0, "unreachable", "Can't reach Hearth right now."), "x"),
    ).toBe("Can't reach Hearth right now.");
    expect(failedMessage(new ApiError(400, "failed", "Database is busy"), "this task")).toBe(
      "Couldn't load this task: Database is busy.",
    );
    expect(failedMessage(new ApiError(400, "failed", "It broke."), "mail")).toBe(
      "Couldn't load mail: It broke.",
    );
    expect(failedMessage(undefined, "your devices")).toBe("Couldn't load your devices.");
  });
});
