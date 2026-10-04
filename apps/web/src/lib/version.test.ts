import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, noticeFor, pageBuild, watchBuild } from "./version.ts";

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

describe("asking which build is running", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks every few minutes only while the page is in view, and when it's back", () => {
    vi.useFakeTimers();
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    let asked = 0;
    const stop = watchBuild(
      () => {
        asked += 1;
      },
      win,
      doc,
    );
    expect(asked).toBe(1);
    vi.advanceTimersByTime(CHECK_EVERY_MS);
    expect(asked).toBe(2);
    // A tab left in the background doesn't ask.
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(6 * CHECK_EVERY_MS);
    expect(asked).toBe(2);
    // Back in view, or back online: it asks at once.
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(asked).toBe(3);
    win.dispatchEvent(new Event("online"));
    expect(asked).toBe(4);
    stop();
    vi.advanceTimersByTime(CHECK_EVERY_MS);
    win.dispatchEvent(new Event("online"));
    expect(asked).toBe(4);
  });
});
