import { describe, expect, it } from "vitest";
import { filterSchema, matches } from "./filter.ts";

const event = {
  kind: "task.updated",
  payload: { status: "in_review", tags: ["home"], estimate: 90 },
};

describe("filter", () => {
  it("evaluates conditions and combinators", () => {
    expect(matches({ field: "kind", op: "eq", value: "task.updated" }, event)).toBe(true);
    expect(
      matches({ field: "payload.status", op: "in", value: ["completed", "in_review"] }, event),
    ).toBe(true);
    expect(matches({ field: "payload.tags", op: "contains", value: "home" }, event)).toBe(true);
    expect(matches({ field: "payload.estimate", op: "gte", value: 60 }, event)).toBe(true);
    expect(matches({ field: "payload.missing", op: "exists" }, event)).toBe(false);
    expect(
      matches(
        {
          and: [
            { field: "kind", op: "eq", value: "task.updated" },
            { not: { field: "payload.status", op: "eq", value: "completed" } },
            {
              or: [
                { field: "payload.estimate", op: "lt", value: 10 },
                { field: "kind", op: "contains", value: "TASK" },
              ],
            },
          ],
        },
        event,
      ),
    ).toBe(true);
  });

  it("does not compare mismatched types", () => {
    expect(matches({ field: "payload.estimate", op: "gt", value: "5" }, event)).toBe(false);
  });

  it("validates filters with the schema", () => {
    expect(filterSchema.safeParse({ and: [{ field: "kind", op: "eq", value: "x" }] }).success).toBe(
      true,
    );
    expect(filterSchema.safeParse({ field: "kind", op: "like", value: "x" }).success).toBe(false);
  });
});
