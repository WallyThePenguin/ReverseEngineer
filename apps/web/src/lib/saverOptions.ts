// What a whole save (wholeSave.ts) is told about the record it saves, and what it reads back.

export interface Remote<T> {
  title: string;
  data: T;
  version: number;
}

export interface SaverOptions<T> {
  /** The record it saves: once it's restored from the trash, what was changed meanwhile is saved. */
  id: string;
  /** Where its unsaved copies are kept: "canvas:<id>" (each screen's under "canvas:<id>#…"). */
  key: string;
  /** The action that saves it, and its input. */
  action: string;
  input(data: T, baseVersion: number, title: string | undefined): unknown;
  get(): Promise<Remote<T>>;
  merge(base: T, mine: T, theirs: T): T;
  /**
   * One with nothing in it (a new board, a new spreadsheet's one empty sheet, no notes). A copy an
   * older Hearth kept before the first read has no base, and is merged onto this as if everything
   * in it had been added here.
   */
  empty(): T;
  /** A plain copy of what's on screen. */
  current(): T;
  /** Puts a copy that came from elsewhere, or a merge, on screen. */
  show(data: T, title?: string): void;
  /** What it is, for messages: "board", "spreadsheet". */
  noun: string;
  /** The version a save's result says it saved as (by default its `version`). */
  savedAs?(result: unknown): number;
}
