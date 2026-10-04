import { describe, expect, it } from "vitest";
import { noticeFor, pageBuild } from "./version.ts";

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
    // A page without its build stamped in can't say it's out of date.
    expect(noticeFor(null, { build: "def", migrations: fits })).toBeNull();
    expect(noticeFor(null, { build: "def", migrations: { ok: false } })).toBe("mismatch");
  });

  it("reads the page's build from index.html", () => {
    const page = (content: string | null) => ({
      querySelector: (q: string) =>
        q === 'meta[name="hearth-build"]' && content !== null ? { content } : null,
    });
    expect(pageBuild(page("abc") as unknown as Document)).toBe("abc");
    expect(pageBuild(page("") as unknown as Document)).toBeNull();
    expect(pageBuild(page(null) as unknown as Document)).toBeNull();
  });
});
