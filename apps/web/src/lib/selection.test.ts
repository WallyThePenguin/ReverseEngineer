// The keyboard's row is kept by id: new rows above it don't move it to another item, and when
// its row goes, the row that took its place is selected (and highlighted).
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createSelection, resolveIndex } from "./selection.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

describe("resolveIndex", () => {
  it("follows the selected id wherever it moves", () => {
    expect(resolveIndex(["a", "b", "c"], "b", 1)).toBe(1);
    expect(resolveIndex(["new", "a", "b", "c"], "b", 1)).toBe(2);
  });

  it("lands on the row that took a gone row's place, within the list", () => {
    expect(resolveIndex(["a", "c"], "b", 1)).toBe(1);
    // The last row went: the new last row, never a row past the end.
    expect(resolveIndex(["a", "b"], "c", 2)).toBe(1);
  });

  it("is -1 for an empty list, and the top before anything is picked", () => {
    expect(resolveIndex([], "a", 3)).toBe(-1);
    expect(resolveIndex(["a", "b"], null, 0)).toBe(0);
  });
});

describe("createSelection", () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id }));
  const setup = (...ids: string[]) =>
    createRoot((dispose) => {
      const [list, setList] = createSignal(rows(...ids));
      return { sel: createSelection(list, (r) => r.id), setList, dispose };
    });

  it("keeps the same item selected when rows arrive above it", () => {
    const { sel, setList, dispose } = setup("a", "b", "c");
    sel.select(1);
    expect(sel.current()?.id).toBe("b");
    setList(rows("new", "a", "b", "c"));
    expect(sel.index()).toBe(2);
    expect(sel.current()?.id).toBe("b");
    dispose();
  });

  it("moves to the row that took the place of one that went, and stays on it", () => {
    const { sel, setList, dispose } = setup("a", "b", "c");
    sel.select(2);
    // Marked done: the last row goes, and the new last row is the one selected.
    setList(rows("a", "b"));
    expect(sel.current()?.id).toBe("b");
    // From then on it is that row, wherever it moves.
    setList(rows("new", "a", "b"));
    expect(sel.current()?.id).toBe("b");
    setList([]);
    expect(sel.index()).toBe(-1);
    expect(sel.current()).toBeUndefined();
    dispose();
  });

  it("goes back to a row that comes back (a refused done), unless you've moved since", () => {
    const { sel, setList, dispose } = setup("new", "a", "b");
    sel.select(0);
    // Done at once; Hearth says no and it's put back.
    setList(rows("a", "b"));
    expect(sel.current()?.id).toBe("a");
    setList(rows("new", "a", "b"));
    expect(sel.current()?.id).toBe("new");
    // This time you move on before it comes back: the selection stays where you put it.
    setList(rows("a", "b"));
    sel.select(1);
    setList(rows("new", "a", "b"));
    expect(sel.current()?.id).toBe("b");
    dispose();
  });

  it("pins the top row once the list is shown, so arrivals above don't move it", () => {
    const { sel, setList, dispose } = setup("a", "b");
    expect(sel.current()?.id).toBe("a");
    setList(rows("new", "a", "b"));
    expect(sel.current()?.id).toBe("a");
    dispose();
  });

  it("goes back to the top of the list that replaces a reset one", () => {
    const { sel, setList, dispose } = setup("a", "b", "c");
    sel.select(2);
    sel.reset();
    expect(sel.index()).toBe(0);
    // Another filter's rows, which happen to include the earlier top row further down.
    setList(rows("x", "a"));
    expect(sel.current()?.id).toBe("x");
    setList(rows("new", "x", "a"));
    expect(sel.current()?.id).toBe("x");
    dispose();
  });

  it("pins the top of a list that showed before the reset, so a new row above doesn't take it", async () => {
    const { sel, setList, dispose } = setup("a", "b", "c");
    sel.select(2);
    // Another filter's rows, read before, come at once: before the reset.
    setList(rows("x", "y"));
    sel.reset();
    await Promise.resolve();
    setList(rows("new", "x", "y"));
    expect(sel.current()?.id).toBe("x");
    // Reset onto a list read again just as it was (the very same list): its top row stays.
    sel.reset();
    await Promise.resolve();
    setList(rows("newer", "new", "x", "y"));
    expect(sel.current()?.id).toBe("new");
    dispose();
  });

  it("selects a search's own top once it answers, though the old top is among the results", async () => {
    const { sel, setTerm, setFound, dispose } = createRoot((dispose) => {
      const [term, setTerm] = createSignal("");
      const [found, setFound] = createSignal<{ id: string }[]>();
      const inbox = rows("a", "b", "c");
      const sel = createSelection(
        () => (term() ? (found() ?? []) : inbox),
        (r) => r.id,
      );
      // As Mail does: reset when the searched-for words change, once typing pauses.
      createEffect(on(term, () => sel.reset(), { defer: true }));
      return { sel, setTerm, setFound, dispose };
    });
    expect(sel.current()?.id).toBe("a");
    // Typing: nothing changes for the pause. Then the search goes out, and answers later.
    setTerm("lease");
    await Promise.resolve();
    setFound(rows("c", "a"));
    expect(sel.current()?.id).toBe("c");
    dispose();
  });
});
