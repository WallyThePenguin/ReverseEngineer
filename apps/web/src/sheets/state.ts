// One open spreadsheet: the workbook as typed, its results, undo and redo, and saving. Every change
// is saved whole a moment after you stop, kept on this device until Hearth has it, and merged cell
// by cell with anything saved elsewhere meanwhile (Jarvis, another screen): D59.

import {
  emptyWorkbook,
  mergeWorkbook,
  type Results,
  renameSheetRefs,
  type Workbook,
} from "@hearth/core";
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { action } from "../lib/api.ts";
import { reportError } from "../lib/live.ts";
import { createSaver } from "../lib/wholeSave.ts";
import { engine } from "./engine.ts";

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
  const [served, setServed] = createSignal<Results>([]);
  const [calc, setCalc] = createSignal<((b: Workbook) => Results) | null>(null);
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

  const saver = createSaver<Workbook>({
    id,
    key: `sheet:${id}`,
    noun: "spreadsheet",
    action: "sheet.save",
    input: (data, baseVersion, name) => ({
      id,
      book: data,
      baseVersion,
      ...(name !== undefined ? { title: name } : {}),
    }),
    async get() {
      const r = await action<{
        title: string;
        book: Workbook;
        results: Results;
        version: number;
      }>("sheet.get", { id });
      setServed(r.results);
      return { title: r.title, data: r.book, version: r.version };
    },
    merge: mergeWorkbook,
    // What the screen starts as, not no sheets at all: a cell typed in its "Sheet1" before the
    // first read then doesn't put that name back over the one Hearth's sheet has.
    empty: emptyWorkbook,
    current: () => copy(book),
    show(data, name) {
      batch(() => {
        if (name !== undefined && !saver.renaming()) setTitle(name);
        setBook(data);
        setLoaded(true);
      });
    },
  });

  /** Changes the workbook as one undoable step. */
  const change = (fn: (draft: Workbook) => void) => {
    undo.push(copy(book));
    if (undo.length > MAX_UNDO) undo.shift();
    redo.length = 0;
    const next = copy(book);
    fn(next);
    setBook(next);
    saver.changed();
  };

  const swap = (from: Workbook[], to: Workbook[]) => {
    const prev = from.pop();
    if (!prev) return;
    to.push(copy(book));
    setBook(prev);
    saver.changed();
  };

  return {
    book,
    title,
    loaded,
    saving: saver.saving,
    /** Why the spreadsheet isn't saved, in plain words, or null. */
    problem: saver.problem,
    results,
    /** Reads it from Hearth, keeping what's unsaved here on top. */
    load: saver.load,
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
    /** Renames a sheet, and every formula that points at it. */
    renameSheet(sheet: number, name: string) {
      change((d) => {
        Object.assign(d, renameSheetRefs(d, sheet, name));
      });
    },
    undo: () => swap(undo, redo),
    redo: () => swap(redo, undo),
    rename(t: string) {
      setTitle(t);
      saver.rename(t);
    },
    /** Saves now and stops watching for the page closing (closing the spreadsheet). */
    flush: saver.close,
  };
}

export type Sheet = ReturnType<typeof createSheet>;
