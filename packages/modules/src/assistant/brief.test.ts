import { describe, expect, it } from "vitest";
import { renderBrief, renderDigest } from "./brief.ts";

describe("brief rendering", () => {
  it("orders items handled, prepared, needs a yes, today, also", () => {
    const md = renderDigest([
      {
        module: "tasks",
        items: [
          { bucket: "today", text: "Due today: T-3 Taxes" },
          { bucket: "handled", text: "T-9 done" },
        ],
      },
      { module: "approvals", items: [{ bucket: "needs_yes", text: "Send email to Ana" }] },
      { module: "system", items: [{ bucket: "fyi", text: "gmail sync is degraded" }] },
    ]);
    expect(md).toBe(
      "## Handled\n- T-9 done\n\n## Needs a yes\n- Send email to Ana\n\n## Today\n- Due today: T-3 Taxes\n\n## Also\n- gmail sync is degraded",
    );
  });
  it("says so when nothing needs you", () => {
    expect(renderBrief([], new Date("2026-10-01T12:15:00Z"))).toBe(
      "Brief for 2026-10-01 8:15 a.m.\n\nNothing needs you. Quiet day so far.",
    );
  });
});
