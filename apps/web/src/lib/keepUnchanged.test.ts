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

  it("keeps two rows that read the same as two, not one twice", () => {
    const [x, y] = [{ v: 1 }, { v: 1 }];
    const next = keepUnchanged([x, y], [{ v: 1 }, { v: 1 }, { v: 1 }]);
    expect(new Set(next).size).toBe(3);
    expect(next.slice(0, 2)).toEqual([x, y]);
  });

  it("takes the new read whole when the shape is different, or there was none", () => {
    const next = [row("a")];
    expect(keepUnchanged(undefined, next)).toBe(next);
    expect(keepUnchanged({ a: 1 }, next)).toBe(next);
    expect(keepUnchanged([1, 2], "two")).toBe("two");
  });
});
