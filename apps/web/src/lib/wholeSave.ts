// Saving a board, a spreadsheet or meeting notes, which are saved whole (D59). A change is saved a
// moment after you stop, with the version it was made on. Until Hearth has it, a copy waits in
// IndexedDB, so a closed tab, a crash or a dropped connection loses nothing: the next open after
// its screen has closed sends it. A save that fails for want of a connection is tried again with
// backoff; one Hearth turns down because someone saved first (Jarvis adding cards, another screen)
// is merged piece by piece and sent again. Changes made after it was deleted are kept too. Each
// screen keeps its own copy, so two tabs never replace each other's. With Web Locks, each holds a
// lock on its copy while it's open, and a screen opening it takes in only the copies of screens
// that have closed, as does one with it open once it's restored; without them (a page on plain
// http, an older browser) there's no telling, so either takes in every other copy, a still-open
// screen's too (copyLocks.ts). No change is taken before the first read (of Hearth's copy, or of
// one kept here).

import { randomHex } from "@hearth/core";
import { createSignal } from "solid-js";
import { ApiError, action, isOffline, isTransient, notYet } from "./api.ts";
import { closedCopies, holdCopy } from "./copyLocks.ts";
import { dropUnsaved, saveUnsaved, takeOverUnsaved } from "./docStore.ts";
import { backoff, onLiveEvent } from "./live.ts";

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

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createSaver<T>(o: SaverOptions<T>) {
  const [saving, setSaving] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [gone, setGone] = createSignal(false);
  /** Hearth's copy, or one kept here, has been read: until then it takes no change. */
  const [loaded, setLoaded] = createSignal(false);
  /** This screen's own copy: no other screen replaces it, nor it theirs. */
  const own = `${o.key}#${randomHex(8)}`;
  /** Its copy's lock, held until it closes: nothing is kept, nor taken over, before it's held. */
  const lock = holdCopy(own);
  let version = 0;
  let base: T | null = null;
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
  let rereading: number | undefined;
  let keeping = false;
  let closed = false;
  /** Restores heard: one heard while a request was out makes its "not found" out of date. */
  let restores = 0;

  const unsaved = () => dirty || title !== undefined;
  /** Hearth answered for the trash, but it was restored after the request went: ask again. */
  const stale = (err: unknown, heard: number) =>
    err instanceof ApiError && err.code === "not_found" && heard !== restores;

  const copy = () => ({ key: own, data: o.current(), base, baseVersion: version, title });
  /** Writes this screen's copy (once per tick, however many changes it held). */
  const keep = () => {
    if (keeping) return;
    keeping = true;
    void lock.held.then(() => {
      keeping = false;
      if (unsaved()) void saveUnsaved(copy());
    });
  };

  const refused = (err: unknown) => {
    if (err instanceof ApiError && err.code === "not_found") {
      setGone(true);
      // Never read here (it opened from the trash): restoring it is what opens it.
      setProblem(
        loaded()
          ? `This ${o.noun} was deleted. Restore it from the trash to save changes here.`
          : `This ${o.noun} is in the trash. Restore it to open it here.`,
      );
    } else setProblem(`Hearth didn't save this: ${reason(err)}`);
  };

  const later = (err: unknown) => {
    setProblem(notYet(err));
    window.clearTimeout(retry);
    // Once it's closed, the copy kept here waits for the next open instead.
    if (!closed) retry = window.setTimeout(() => void save(), backoff(attempt++));
  };

  /** Takes in what was saved elsewhere and puts this screen's changes on top. */
  const mergeWith = (theirs: Remote<T>) => {
    const merged = o.merge(base ?? o.empty(), o.current(), theirs.data);
    base = theirs.data;
    version = theirs.version;
    o.show(merged);
    dirty = !sameJson(merged, theirs.data);
    if (dirty) keep();
  };

  function save(keepalive = false): Promise<void> {
    if (!loaded() || gone()) return Promise.resolve();
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
        const heard = restores;
        dirty = false;
        setSaving(true);
        try {
          const small = keepalive && JSON.stringify(input).length < KEEPALIVE_MAX;
          const r = await action<{ version: number }>(o.action, input, {
            timeoutMs: TIMEOUT_MS,
            keepalive: small,
          });
          version = o.savedAs ? o.savedAs(r) : r.version;
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
              if (isTransient(e)) later(e);
              else if (stale(e, heard)) again = true;
              else refused(e);
            }
          } else if (stale(err, heard)) again = true;
          else if (isTransient(err) || merges >= MAX_MERGES) later(err);
          else refused(err);
        }
      } while (again);
      // Everything here has reached Hearth: the copy kept in case it didn't can go.
      if (!unsaved()) await dropUnsaved(own);
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

  /**
   * The first look: Hearth's copy (null when reading it failed, because of `why`) and the copies
   * kept here that it takes over (copyLocks.ts).
   */
  async function open(r: Remote<T> | null, why?: unknown): Promise<void> {
    const copies = await lock.held.then(() => closedCopies<T>(o.key, own));
    // Another read got here first, or it was closed meanwhile: it takes nothing over.
    if (loaded() || closed) return;
    if (!r && !copies.length) {
      setProblem(
        isOffline(why)
          ? `Can't open this ${o.noun} right now: can't reach Hearth. Trying again…`
          : `Can't open this ${o.noun} right now: Hearth hit a problem. Trying again…`,
      );
      window.clearTimeout(retry);
      if (!closed) retry = window.setTimeout(() => void load(), backoff(attempt++));
      return;
    }
    setLoaded(true);
    setProblem(null);
    if (r && !copies.length) {
      base = r.data;
      version = r.version;
      o.show(r.data, r.title);
      return;
    }
    // Changes made here that never reached Hearth (a tab closed, Hearth was out of reach, it was
    // in the trash), a copy per screen. Each is merged onto Hearth's copy (offline, onto the one
    // made on the newest version) with what it was made on as its base, as a save that lost a
    // race is. One without a base is merged onto an empty one (see `empty`).
    const newest = copies.reduce((a, k) => (k.baseVersion > a.baseVersion ? k : a));
    let data = r ? r.data : newest.data;
    for (const k of copies)
      if (r || k !== newest) data = o.merge(k.base ?? o.empty(), k.data, data);
    base = r ? r.data : (newest.base ?? o.empty());
    version = r ? r.version : newest.baseVersion;
    const name = copies.find((k) => k.title !== undefined)?.title;
    // show() leaves the name on screen while a new one waits to be saved, so this one goes first.
    o.show(data, name ?? r?.title);
    title = name !== r?.title ? name : undefined;
    dirty = !r || !sameJson(data, r.data);
    // This screen's copy holds them all now, so the others go.
    await takeOverUnsaved(unsaved() ? copy() : null, copies);
    if (unsaved()) void save();
  }

  /**
   * Takes in what screens kept that have closed since (one closed while it was in the trash); an
   * open one saves its own once it hears the restore. Each is merged into this screen with what it
   * was made on as its base, and goes, as this screen now holds it, in its own copy until Hearth
   * has it.
   */
  async function absorb(): Promise<void> {
    if (!loaded()) return;
    const others = await lock.held.then(() => closedCopies<T>(o.key, own));
    if (!others.length) return;
    const now = o.current();
    let data = now;
    for (const k of others) data = o.merge(k.base ?? o.empty(), data, k.data);
    const name = title ?? others.find((k) => k.title !== undefined)?.title;
    if (!sameJson(data, now) || name !== title) {
      o.show(data, name);
      title = name;
      dirty = true;
      edits += 1;
    }
    await takeOverUnsaved(unsaved() ? copy() : null, others);
  }

  async function load(): Promise<void> {
    if (running) {
      reload = true;
      return;
    }
    const at = edits;
    const heard = restores;
    let r: Remote<T>;
    try {
      r = await o.get();
    } catch (err) {
      if (stale(err, heard)) return load();
      if (err instanceof ApiError && err.code === "not_found") refused(err);
      else if (!loaded() && isTransient(err)) await open(null, err);
      // Turned down: that's why it takes no change.
      else if (!loaded())
        setProblem(
          `Hearth didn't open this ${o.noun}, so it can't be changed here: ${reason(err)}`,
        );
      // Open already: a newer version it couldn't read is read again soon, not at the next one.
      else if (isTransient(err)) {
        window.clearTimeout(rereading);
        if (!closed) rereading = window.setTimeout(() => void load(), backoff(attempt++));
      }
      return;
    }
    if (!loaded()) return open(r);
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

  /**
   * Restored from the trash: read it again if Hearth said it was gone, and save what was changed
   * meanwhile, here and on screens closed since.
   */
  async function restored(): Promise<void> {
    if (gone()) {
      setGone(false);
      setProblem(null);
      await load();
    }
    await absorb();
    if (unsaved()) void save();
  }
  const stopLive = onLiveEvent((e) => {
    if (e.kind !== "entity.restored" || e.entityId !== o.id) return;
    restores++;
    void restored();
  });

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
  // Back online: try a first read that failed again, or send what's waiting.
  const online = () => (loaded() ? unsaved() && void save() : void load());
  window.addEventListener("pagehide", hidden);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("beforeunload", guard);
  window.addEventListener("online", online);

  return {
    saving,
    /** Why the last change isn't saved, in plain words, or null. */
    problem,
    /** Hearth said it's in the trash, and it hasn't been restored since. */
    gone,
    loaded,
    load,
    /**
     * The screen changed it: save a moment after the last change. Before the first read there's
     * no version it was made on, so it's ignored.
     */
    changed() {
      if (!loaded()) return;
      dirty = true;
      edits += 1;
      keep();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void save(), SAVE_AFTER_MS);
    },
    rename(name: string) {
      if (!loaded()) return;
      title = name;
      keep();
      void save();
    },
    /** Whether a new name is waiting to be saved (so a copy from elsewhere doesn't undo it). */
    renaming: () => title !== undefined,
    /** Saves now and stops listening (closing it). */
    close() {
      closed = true;
      stopLive();
      window.removeEventListener("pagehide", hidden);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("online", online);
      window.clearTimeout(retry);
      window.clearTimeout(rereading);
      // Its copy's lock goes once this save is done: until then no other screen takes the copy.
      return save().finally(lock.release);
    },
  };
}

export type Saver = ReturnType<typeof createSaver>;
