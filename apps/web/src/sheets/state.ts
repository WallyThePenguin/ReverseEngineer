// One open spreadsheet: the workbook as typed, its results, undo and redo, and saving. Every change
// is saved whole a moment after you stop (last write wins, D20); a save from elsewhere (Jarvis, another
// screen) is taken in when you have nothing unsaved.

import { emptyWorkbook, type Results, type Workbook } from "@hearth/core";
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { action } from "../lib/api.ts";
import { reportError } from "../lib/live.ts";
import { engine } from "./engine.ts";

const SAVE_AFTER_MS = 700;
const MAX_UNDO = 100;

const copy = (b: Workbook): Workbook => structuredClone(unwrap(b));

export function createSheet(id: string) {
  const [book, setStore] = createStore<Workbook>(emptyWorkbook());
  // Bumped on every change: working out results reads an untracked copy of the whole workbook.
  const [rev, setRev] = createSignal(0);
  const setBook = (b: Workbook) => {
    setStore(reconcile(b, { key: "id" }));
    setRev((n) => n + 1);
  };
  const [title, setTitle] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [served, setServed] = createSignal<Results>([]);
  const [calc, setCalc] = createSignal<((b: Workbook) => Results) | null>(null);
  let version = 0;
  let dirty = false;
  let saves = 0;
  let edits = 0;
  let renaming = false;
  let timer: number | undefined;
  const undo: Workbook[] = [];
  const redo: Workbook[] = [];

  engine()
    .then((fn) => setCalc(() => fn))
    .catch(reportError);

  // Worked out here once the engine has loaded; until then, what the server worked out.
  const results = createMemo<Results>(() => {
    const fn = calc();
    rev();
    if (!fn) return served();
    try {
      return fn(copy(book));
    } catch (err) {
      reportError(err);
      return served();
    }
  });

  const save = async () => {
    if (!dirty) return;
    dirty = false;
    setSaving(true);
    saves += 1;
    try {
      const r = await action<{ version: number }>("sheet.save", { id, book: copy(book) });
      version = Math.max(version, r.version);
    } catch (err) {
      dirty = true;
      reportError(err);
    } finally {
      saves -= 1;
      setSaving(saves > 0);
    }
  };

  const changed = () => {
    dirty = true;
    edits += 1;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void save(), SAVE_AFTER_MS);
  };

  /** Changes the workbook as one undoable step. */
  const change = (fn: (draft: Workbook) => void) => {
    undo.push(copy(book));
    if (undo.length > MAX_UNDO) undo.shift();
    redo.length = 0;
    const next = copy(book);
    fn(next);
    setBook(next);
    changed();
  };

  const swap = (from: Workbook[], to: Workbook[]) => {
    const prev = from.pop();
    if (!prev) return;
    to.push(copy(book));
    setBook(prev);
    changed();
  };

  return {
    book,
    title,
    loaded,
    saving,
    results,
    async load() {
      const at = edits;
      try {
        const r = await action<{
          title: string;
          book: Workbook;
          results: Results;
          version: number;
        }>("sheet.get", { id });
        // What you've done since asking, or haven't saved yet, wins over the copy that came back.
        if (dirty || saves > 0 || edits !== at) return;
        if (loaded() && r.version <= version) return;
        version = r.version;
        batch(() => {
          if (!renaming) setTitle(r.title);
          setServed(r.results);
          setBook(r.book);
          setLoaded(true);
        });
      } catch (err) {
        reportError(err);
      }
    },
    change,
    /** Sets cells on one sheet: "" clears. */
    set(sheet: number, cells: Record<string, string>) {
      const s = book.sheets[sheet];
      if (!s || Object.entries(cells).every(([k, v]) => (s.cells[k] ?? "") === v)) return;
      change((d) => {
        const target = d.sheets[sheet]!;
        for (const [k, v] of Object.entries(cells)) {
          if (v === "") delete target.cells[k];
          else target.cells[k] = v;
        }
      });
    },
    undo: () => swap(undo, redo),
    redo: () => swap(redo, undo),
    async rename(t: string) {
      setTitle(t);
      renaming = true;
      try {
        const r = await action<{ version: number }>("sheet.save", {
          id,
          book: copy(book),
          title: t,
        });
        version = Math.max(version, r.version);
      } catch (err) {
        reportError(err);
      } finally {
        renaming = false;
      }
    },
    /** Saves now (closing the spreadsheet). */
    flush: () => {
      window.clearTimeout(timer);
      return save();
    },
  };
}

export type Sheet = ReturnType<typeof createSheet>;
