// A read again keeps the rows that didn't change as the same objects, wherever they moved, so a
// list draws only the rows that changed. (That Solid's query library hands these to the list is
// checked in a browser, by e2e:daily.)
import { describe, expect, it } from "vitest";
import { keepUnchanged } from "./keepUnchanged.ts";

const row = (id: string, title = id) => ({ notification: { id, title }, approvalStatus: null });
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("keepUnchanged", () => {
  it("is the old read itself when nothing changed", () => {
    const old = [row("a"), row("b")];
    expect(keepUnchanged(old, copy(old))).toBe(old);
    const wrapped = { items: old, total: 2 };
    expect(keepUnchanged(wrapped, copy(wrapped))).toBe(wrapped);
  });

  it("keeps each unchanged row wherever it moved: one new above them, one gone", () => {
    const [a, b, c] = [row("a"), row("b"), row("c")];
    const next = keepUnchanged([a, b, c], [row("new"), row("a"), row("c")]);
    expect(next[0]).toEqual(row("new"));
    expect(next[1]).toBe(a);
    expect(next[2]).toBe(c);
  });

  it("gives a changed row as it now is, and keeps the rest", () => {
    const [a, b] = [row("a"), row("b")];
    const next = keepUnchanged({ items: [a, b] }, { items: [row("a", "Renamed"), row("b")] });
    expect(next.items[0]).toEqual(row("a", "Renamed"));
    expect(next.items[0]).not.toBe(a);
    expect(next.items[1]).toBe(b);
  });

  it("keeps two rows that read the same as two, never one object twice", () => {
    // Two "Call Sam" tasks: a <For> over one object twice would draw one row for both.
    const sam = () => ({ title: "Call Sam", done: false });
    const [x, y] = [sam(), sam()];
    const next = keepUnchanged([x, y], [{ title: "New" }, sam(), sam(), sam()]);
    expect(next[1]).toBe(x);
    expect(next[2]).toBe(y);
    expect(next[3]).toEqual(sam());
    expect(new Set(next).size).toBe(4);
    // One of them done: the other is kept, and the done one is as it now is.
    const after = keepUnchanged([x, y], [sam(), { title: "Call Sam", done: true }]);
    expect(after[0]).toBe(x);
    expect(after[1]).toEqual({ title: "Call Sam", done: true });
  });

  it("takes the new read whole when the shape is different, or there was none", () => {
    const next = [row("a")];
    expect(keepUnchanged(undefined, next)).toBe(next);
    expect(keepUnchanged({ a: 1 }, next)).toBe(next);
    expect(keepUnchanged([1, 2], "two")).toBe("two");
    // An old empty place isn't taken for what's there now.
    expect(keepUnchanged([undefined], [{ a: 1 }])).toEqual([{ a: 1 }]);
    // What JSON can't hold is never taken as unchanged, and doesn't stop the read.
    expect(keepUnchanged([{ n: 1n }], [{ n: 2n }])).toEqual([{ n: 2n }]);
  });

  it("keeps a page's unchanged rows when one row on it changed (Mail, read a page at a time)", () => {
    const thread = (id: string, unread = true) => ({ id, subject: `About ${id}`, unread });
    const old = {
      pages: [[thread("1"), thread("2"), thread("3")], [thread("4")]],
      pageParams: [0, 3],
    };
    const next = keepUnchanged(old, {
      pages: [[thread("1"), thread("2", false), thread("3")], [thread("4")]],
      pageParams: [0, 3],
    });
    expect(next.pages[0]![0]).toBe(old.pages[0]![0]);
    expect(next.pages[0]![1]).toEqual(thread("2", false));
    expect(next.pages[0]![2]).toBe(old.pages[0]![2]);
    expect(next.pages[1]).toBe(old.pages[1]);
    expect(next.pageParams).toBe(old.pageParams);
  });

  it("finds a changed row by its id wherever it moved, and keeps its unchanged parts", () => {
    const t = (id: string, subject = id) => ({ id, subject, from: { name: `Sender ${id}` } });
    const [a, b, c] = [t("a"), t("b"), t("c")];
    // b has a new message: it comes back on top, with a new subject.
    const next = keepUnchanged([a, b, c], [t("b", "Re: b"), t("a"), t("c")]);
    expect(next[0]).not.toBe(b);
    expect(next[0]!.from).toBe(b.from);
    expect(next[1]).toBe(a);
    expect(next[2]).toBe(c);
  });

  it("goes by place for rows whose id is missing or null, many of them at once", () => {
    const row = (i: number, seen: boolean) => ({ id: null, n: i, at: { i }, seen });
    const old = Array.from({ length: 5000 }, (_, i) => row(i, false));
    const started = performance.now();
    const next = keepUnchanged(
      old,
      Array.from({ length: 5000 }, (_, i) => row(i, true)),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(next[4999]!.at).toBe(old[4999]!.at);
  });
});
