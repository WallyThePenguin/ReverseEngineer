import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import { degraded, meansDegraded } from "./degraded.ts";

const DB_DOWN = "Hearth's database isn't reachable right now. Try again in a moment.";

describe("the degraded banner", () => {
  it("is about Hearth's database, not any unavailable thing", () => {
    expect(meansDegraded(new ApiError(503, "failed", DB_DOWN))).toBe(true);
    expect(meansDegraded(new ApiError(400, "unavailable", DB_DOWN))).toBe(true);
    const renamed = DB_DOWN.replace("Hearth's", "Nook's");
    expect(meansDegraded(new ApiError(503, "failed", renamed))).toBe(true);
    expect(meansDegraded(new ApiError(400, "unavailable", "Chrome isn't connected."))).toBe(false);
    expect(meansDegraded(new ApiError(0, "unreachable", "Can't reach Nook right now."))).toBe(
      false,
    );
    expect(meansDegraded(null)).toBe(false);
  });

  it("comes on with a database failure and goes once a read works", () => {
    degraded.failed(new ApiError(400, "not_found", "Task not found"));
    expect(degraded.on()).toBe(false);
    degraded.failed(new ApiError(503, "failed", DB_DOWN));
    expect(degraded.on()).toBe(true);
    // Another kind of failure doesn't clear it; only a read that works does.
    degraded.failed(new ApiError(400, "not_found", "Task not found"));
    expect(degraded.on()).toBe(true);
    degraded.worked();
    expect(degraded.on()).toBe(false);
  });
});
