// One open board: what's on it, what's selected, undo and redo, and saving. Every change is saved
// whole a moment after you stop, kept on this device until Hearth has it, and merged card by card
// with anything saved elsewhere meanwhile (Jarvis adding cards, another screen): D59.

import { type Canvas, type CanvasEdge, type CanvasNode, mergeCanvas } from "@hearth/core";
import { batch, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { action } from "../lib/api.ts";
import { createSaver } from "../lib/wholeSave.ts";

export type Tool = "select" | "text" | "rectangle" | "ellipse" | "arrow";

const MAX_UNDO = 100;

export const newId = () => crypto.randomUUID().slice(0, 12);

const copy = (c: Canvas): Canvas => structuredClone(unwrap(c));

export function createBoard(id: string) {
  const [board, setBoard] = createStore<Canvas>({ nodes: [], edges: [] });
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [tool, setTool] = createSignal<Tool>("select");
  const [title, setTitle] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const undo: Canvas[] = [];
  const redo: Canvas[] = [];

  const saver = createSaver<Canvas>({
    id,
    key: `canvas:${id}`,
    noun: "board",
    action: "canvas.save",
    input: (data, baseVersion, name) => ({
      id,
      board: data,
      baseVersion,
      ...(name !== undefined ? { title: name } : {}),
    }),
    async get() {
      const r = await action<{ title: string; board: Canvas; version: number }>("canvas.get", {
        id,
      });
      return { title: r.title, data: r.board, version: r.version };
    },
    merge: mergeCanvas,
    current: () => copy(board),
    show(data, name) {
      batch(() => {
        if (name !== undefined && !saver.renaming()) setTitle(name);
        setBoard(reconcile(data, { key: "id" }));
        setLoaded(true);
      });
    },
  });

  /** Changes the board as one undoable step. */
  const change = (fn: (draft: Canvas) => void) => {
    undo.push(copy(board));
    if (undo.length > MAX_UNDO) undo.shift();
    redo.length = 0;
    const next = copy(board);
    fn(next);
    setBoard(reconcile(next, { key: "id" }));
    saver.changed();
  };

  return {
    board,
    title,
    loaded,
    saving: saver.saving,
    /** Why the board isn't saved, in plain words, or null. */
    problem: saver.problem,
    selected,
    tool,
    setTool,
    select(ids: string[], add = false) {
      setSelected(new Set([...(add ? selected() : []), ...ids]));
    },
    /** Reads it from Hearth, keeping what's unsaved here on top. */
    load: saver.load,
    /** A move or resize in progress: shown at once, saved and undoable as one step at the end. */
    preview(fn: (draft: Canvas) => void) {
      const next = copy(board);
      fn(next);
      setBoard(reconcile(next, { key: "id" }));
    },
    begin() {
      undo.push(copy(board));
      redo.length = 0;
    },
    commit() {
      saver.changed();
    },
    change,
    add(node: CanvasNode) {
      change((d) => {
        d.nodes.push(node);
      });
      setSelected(new Set([node.id]));
    },
    connect(edge: CanvasEdge) {
      change((d) => {
        d.edges.push(edge);
      });
    },
    remove(ids: Set<string>) {
      if (!ids.size) return;
      change((d) => {
        d.nodes = d.nodes.filter((n) => !ids.has(n.id));
        d.edges = d.edges.filter(
          (e) =>
            !ids.has(e.id) &&
            !(e.from.type === "connected" && ids.has(e.from.node)) &&
            !(e.to.type === "connected" && ids.has(e.to.node)),
        );
      });
      setSelected(new Set<string>());
    },
    undo() {
      const prev = undo.pop();
      if (!prev) return;
      redo.push(copy(board));
      setBoard(reconcile(prev, { key: "id" }));
      saver.changed();
    },
    redo() {
      const next = redo.pop();
      if (!next) return;
      undo.push(copy(board));
      setBoard(reconcile(next, { key: "id" }));
      saver.changed();
    },
    rename(t: string) {
      setTitle(t);
      saver.rename(t);
    },
    /** Saves now and stops watching for the page closing (closing the board). */
    flush: saver.close,
  };
}

export type Board = ReturnType<typeof createBoard>;
