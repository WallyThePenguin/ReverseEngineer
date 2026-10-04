import { describe, expect, it } from "vitest";
import { noticeFor } from "./version.ts";

describe("whether the page is the Hearth that's running", () => {
  const fits = { ok: true };
  it("asks for a reload once the server runs a newer build", () => {
    expect(noticeFor("abc", { build: "abc", migrations: fits })).toBeNull();
    expect(noticeFor("abc", { build: "def", migrations: fits })).toBe("updated");
  });

  it("says so when the database doesn't fit the server's code", () => {
    expect(noticeFor("abc", { build: "abc", migrations: { ok: false } })).toBe("mismatch");
  });

  it("stays quiet when it can't tell", () => {
    expect(noticeFor("abc", null)).toBeNull();
    expect(noticeFor("abc", { build: null, migrations: null })).toBeNull();
  });
});
