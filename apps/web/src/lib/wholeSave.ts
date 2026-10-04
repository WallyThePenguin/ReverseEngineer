// Saving a board or a spreadsheet, which are saved whole (D59). A change is saved a moment after
// you stop, with the version it was made on. Until Hearth has it, a copy waits in IndexedDB, so a
// closed tab, a crash or a dropped connection loses nothing: the next open sends it. A save that
// fails for want of a connection is tried again with backoff; one Hearth turns down because
// someone saved first (Jarvis adding cards, another screen) is merged piece by piece and sent again.

import { createSignal } from "solid-js";
import { ApiError, action } from "./api.ts";
import { dropUnsaved, loadUnsaved, saveUnsaved } from "./docStore.ts";
import { backoff } from "./live.ts";

const SAVE_AFTER_MS = 700;
/** A save that hasn't answered by now is treated as lost and tried again. */
const TIMEOUT_MS = 10_000;
/** What a closing page can still send (browsers allow 64 kB). */
const KEEPALIVE_MAX = 60_000;
/** Merges in a row before waiting: someone else is saving as fast as we are. */
const MAX_MERGES = 5;

export interface Remote<T> {
  title: string;
  data: T;
  version: number;
}

export interface SaverOptions<T> {
  /** Where its unsaved copy is kept: "canvas:<id>". */
  key: string;
  /** The action that saves it, and its input. */
  action: string;
  input(data: T, baseVersion: number, title: string | undefined): unknown;
  get(): Promise<Remote<T>>;
  merge(base: T, mine: T, theirs: T): T;
  /** A plain copy of what's on screen. */
  current(): T;
  /** Puts a copy that came from elsewhere, or a merge, on screen. */
  show(data: T, title?: string): void;
  /** What it is, for messages: "board", "spreadsheet". */
  noun: string;
}

/** Errors that say nothing about the save itself: try again later. */
export const isTransient = (err: unknown) =>
  !(err instanceof ApiError) || ["unreachable", "unavailable", "failed"].includes(err.code);

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createSaver<T>(o: SaverOptions<T>) {
  const [saving, setSaving] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [gone, setGone] = createSignal(false);
  let version = 0;
  let base: T | null = null;
  let loaded = false;
  let dirty = false;
  /** A new name that isn't saved yet. */
  let title: string | undefined;
  let running: Promise<void> | null = null;
  let again = false;
  let reload = false;
  let edits = 0;
  let attempt = 0;
  let timer: number | undefined;
  let retry: number | undefined;
  let keeping = false;
  let closed = false;

  const unsaved = () => dirty || title !== undefined;

  /** Writes the unsaved copy (once per tick, however many changes it held). */
  const keep = () => {
    if (keeping) return;
    keeping = true;
    queueMicrotask(() => {
      keeping = false;
      if (!unsaved()) return;
      void saveUnsaved({ key: o.key, data: o.current(), base, baseVersion: version, title });
    });
  };

  const refused = (err: unknown) => {
    if (err instanceof ApiError && err.code === "not_found") {
      setGone(true);
      setProblem(`This ${o.noun} was deleted, so changes here aren't saved.`);
    } else {
      const why = err instanceof Error ? err.message : String(err);
      setProblem(`Hearth didn't save this: ${why}`);
    }
  };

  const later = () => {
    setProblem("Not saved yet: can't reach Hearth. Trying again…");
    window.clearTimeout(retry);
    // Once it's closed, the copy kept here waits for the next open instead.
    if (!closed) retry = window.setTimeout(() => void save(), backoff(attempt++));
  };

  /** Takes in what was saved elsewhere and puts this screen's changes on top. */
  const mergeWith = (theirs: Remote<T>) => {
    const merged = o.merge(base ?? theirs.data, o.current(), theirs.data);
    base = theirs.data;
    version = theirs.version;
    o.show(merged);
    dirty = !sameJson(merged, theirs.data);
    if (dirty) keep();
  };

  function save(keepalive = false): Promise<void> {
    if (!loaded || gone()) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    window.clearTimeout(timer);
    window.clearTimeout(retry);
    running = (async () => {
      let merges = 0;
      do {
        again = false;
        if (!unsaved()) break;
        const data = o.current();
        const name = title;
        const input = o.input(data, version, name);
        dirty = false;
        setSaving(true);
        try {
          const small = keepalive && JSON.stringify(input).length < KEEPALIVE_MAX;
          const r = await action<{ version: number }>(o.action, input, {
            timeoutMs: TIMEOUT_MS,
            keepalive: small,
          });
          version = r.version;
          base = data;
          attempt = 0;
          setProblem(null);
          if (title === name) title = undefined;
        } catch (err) {
          dirty = true;
          if (err instanceof ApiError && err.code === "conflict" && merges < MAX_MERGES) {
            merges++;
            try {
              mergeWith(await o.get());
              again = true;
            } catch (e) {
              if (isTransient(e)) later();
              else refused(e);
            }
          } else if (isTransient(err) || merges >= MAX_MERGES) later();
          else refused(err);
        }
      } while (again);
      // Everything here has reached Hearth: the copy kept in case it didn't can go.
      if (!unsaved()) await dropUnsaved(o.key);
    })().finally(() => {
      running = null;
      setSaving(false);
      if (reload) {
        reload = false;
        void load();
      }
    });
    return running;
  }

  /** The first look: Hearth's copy (null if out of reach) and any changes kept here. */
  async function open(r: Remote<T> | null): Promise<void> {
    const kept = await loadUnsaved<T>(o.key);
    if (!r && !kept) {
      setProblem(`Can't open this ${o.noun} right now: can't reach Hearth. Trying again…`);
      window.clearTimeout(retry);
      if (!closed) retry = window.setTimeout(() => void load(), backoff(attempt++));
      return;
    }
    loaded = true;
    setProblem(null);
    if (r && !kept) {
      base = r.data;
      version = r.version;
      o.show(r.data, r.title);
      return;
    }
    // Changes made here that never reached Hearth: the tab closed, or Hearth was out of reach.
    base = kept!.base ?? r?.data ?? null;
    version = kept!.baseVersion;
    title = kept!.title !== r?.title ? kept!.title : undefined;
    o.show(kept!.data, kept!.title ?? r?.title);
    if (!r) dirty = true;
    else if (kept!.baseVersion !== r.version) mergeWith(r);
    else dirty = !sameJson(kept!.data, r.data);
    if (unsaved()) void save();
    else void dropUnsaved(o.key);
  }

  async function load(): Promise<void> {
    if (running) {
      reload = true;
      return;
    }
    const at = edits;
    let r: Remote<T>;
    try {
      r = await o.get();
    } catch (err) {
      if (err instanceof ApiError && err.code === "not_found") refused(err);
      else if (!loaded && isTransient(err)) await open(null);
      return;
    }
    if (!loaded) return open(r);
    if (r.version <= version) return;
    if (!unsaved() && edits === at) {
      base = r.data;
      version = r.version;
      o.show(r.data, r.title);
      return;
    }
    // Changed here too: saving now finds the newer version and merges with it.
    void save();
  }

  const hidden = () => {
    if (!unsaved() && !running) return;
    if (!running) {
      void save(true);
      return;
    }
    // A save is on its way already; send this one too in case the page doesn't live to see it.
    const input = o.input(o.current(), version, title);
    if (JSON.stringify(input).length < KEEPALIVE_MAX)
      void action(o.action, input, { keepalive: true }).catch(() => {});
  };
  const onVisibility = () => document.visibilityState === "hidden" && hidden();
  const guard = (e: BeforeUnloadEvent) => {
    if (!unsaved() && !running) return;
    e.preventDefault();
    e.returnValue = "";
  };
  const online = () => unsaved() && void save();
  window.addEventListener("pagehide", hidden);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", guard);
  window.addEventListener("online", online);

  return {
    saving,
    /** Why the last change isn't saved, in plain words, or null. */
    problem,
    load,
    /** The screen changed it: save a moment after the last change. */
    changed() {
      dirty = true;
      edits += 1;
      keep();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void save(), SAVE_AFTER_MS);
    },
    rename(name: string) {
      title = name;
      keep();
      void save();
    },
    /** Whether a new name is waiting to be saved (so a copy from elsewhere doesn't undo it). */
    renaming: () => title !== undefined,
    /** Saves now and stops listening (closing it). */
    close() {
      closed = true;
      window.removeEventListener("pagehide", hidden);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("online", online);
      window.clearTimeout(retry);
      return save();
    },
  };
}

export type Saver = ReturnType<typeof createSaver>;
