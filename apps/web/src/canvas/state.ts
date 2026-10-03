// One open board: what's on it, what's selected, undo and redo, and saving. Every change is saved
// whole a moment after you stop (last write wins, D20). A save from elsewhere (Jarvis adding
// cards, another screen) is taken in when you have nothing unsaved.

import type { Canvas, CanvasEdge, CanvasNode } from "@hearth/core";
import { batch, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { action } from "../lib/api.ts";
import { reportError } from "../lib/live.ts";

export type Tool = "select" | "text" | "rectangle" | "ellipse" | "arrow";

const SAVE_AFTER_MS = 700;
const MAX_UNDO = 100;

export const newId = () => crypto.randomUUID().slice(0, 12);

const copy = (c: Canvas): Canvas => structuredClone(unwrap(c));

export function createBoard(id: string) {
  const [board, setBoard] = createStore<Canvas>({ nodes: [], edges: [] });
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [tool, setTool] = createSignal<Tool>("select");
  const [title, setTitle] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let version = 0;
  let dirty = false;
  let saves = 0; // in flight
  let edits = 0;
  let renaming = false;
  let timer: number | undefined;
  const undo: Canvas[] = [];
  const redo: Canvas[] = [];

  const save = async () => {
    if (!dirty) return;
    dirty = false;
    setSaving(true);
    saves += 1;
    try {
      const r = await action<{ version: number }>("canvas.save", { id, board: copy(board) });
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

  /** Changes the board as one undoable step. */
  const change = (fn: (draft: Canvas) => void) => {
    undo.push(copy(board));
    if (undo.length > MAX_UNDO) undo.shift();
    redo.length = 0;
    const next = copy(board);
    fn(next);
    setBoard(reconcile(next, { key: "id" }));
    changed();
  };

  return {
    board,
    title,
    loaded,
    saving,
    selected,
    tool,
    setTool,
    select(ids: string[], add = false) {
      setSelected(new Set([...(add ? selected() : []), ...ids]));
    },
    async load() {
      const at = edits;
      try {
        const r = await action<{ title: string; board: Canvas; version: number }>("canvas.get", {
          id,
        });
        // What you've done since asking, or haven't saved yet, wins over the copy that came back.
        if (dirty || saves > 0 || edits !== at) return;
        if (loaded() && r.version <= version) return;
        version = r.version;
        batch(() => {
          if (!renaming) setTitle(r.title);
          setBoard(reconcile(r.board, { key: "id" }));
          setLoaded(true);
        });
      } catch (err) {
        reportError(err);
      }
    },
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
      changed();
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
      changed();
    },
    redo() {
      const next = redo.pop();
      if (!next) return;
      undo.push(copy(board));
      setBoard(reconcile(next, { key: "id" }));
      changed();
    },
    async rename(t: string) {
      setTitle(t);
      renaming = true;
      try {
        const r = await action<{ version: number }>("canvas.save", {
          id,
          board: copy(board),
          title: t,
        });
        version = Math.max(version, r.version);
      } catch (err) {
        reportError(err);
      } finally {
        renaming = false;
      }
    },
    /** Saves now (closing the board). */
    flush: () => {
      window.clearTimeout(timer);
      return save();
    },
  };
}

export type Board = ReturnType<typeof createBoard>;
