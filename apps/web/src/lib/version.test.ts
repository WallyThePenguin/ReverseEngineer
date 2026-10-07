import { afterEach, describe, expect, it, vi } from "vitest";
import {
  afterLoadFailed,
  CHECK_EVERY_MS,
  freeze,
  moveOnWhenHidden,
  noticeFor,
  pageBuild,
  reloadedFor,
  reloadInto,
  reloadOnReturn,
  tryAgainBy,
  watchBuild,
  whenHidden,
  wouldLoseWork,
} from "./version.ts";

describe("whether the page is the Hearth that's running", () => {
  const fits = { ok: true };
  it("asks for a reload once the server runs a newer build", () => {
    expect(noticeFor("abc", { build: "abc", migrations: fits })).toBeNull();
    expect(noticeFor("abc", { build: "def", migrations: fits })).toBe("updated");
  });

  it("says so when the database doesn't fit the server's code", () => {
    expect(noticeFor("abc", { build: "abc", migrations: { ok: false } })).toBe("mismatch");
  });

  it("stays quiet when it can't tell", () => {
    expect(noticeFor("abc", null)).toBeNull();
    expect(noticeFor("abc", { build: null, migrations: null })).toBeNull();
    // A page without its build stamped in can't say it's out of date.
    expect(noticeFor(null, { build: "def", migrations: fits })).toBeNull();
    expect(noticeFor(null, { build: "def", migrations: { ok: false } })).toBe("mismatch");
  });

  it("reads the page's build from index.html", () => {
    const page = (content: string | null) => ({
      querySelector: (q: string) =>
        q === 'meta[name="hearth-build"]' && content !== null ? { content } : null,
    });
    expect(pageBuild(page("abc") as unknown as Document)).toBe("abc");
    expect(pageBuild(page("") as unknown as Document)).toBeNull();
    expect(pageBuild(page(null) as unknown as Document)).toBeNull();
  });
});

describe("asking which build is running", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks every few minutes only while the page is in view, and when it's back", () => {
    vi.useFakeTimers();
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    // Each ask, and whether it was for the page coming back into view.
    const asked: boolean[] = [];
    const stop = watchBuild((idle) => asked.push(idle !== undefined), win, doc);
    // Opening counts as coming back: it may have opened from a page kept from before an update.
    expect(asked).toEqual([true]);
    vi.advanceTimersByTime(CHECK_EVERY_MS);
    expect(asked).toEqual([true, false]);
    // A tab left in the background doesn't ask, not even when the network comes back (a laptop
    // waking up).
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(6 * CHECK_EVERY_MS);
    win.dispatchEvent(new Event("online"));
    expect(asked).toEqual([true, false]);
    // Back in view, or back online: it asks at once. Only coming back counts as coming back.
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(asked).toEqual([true, false, true]);
    win.dispatchEvent(new Event("online"));
    expect(asked).toEqual([true, false, true, false]);
    stop();
    vi.advanceTimersByTime(CHECK_EVERY_MS);
    win.dispatchEvent(new Event("online"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(asked).toHaveLength(4);
  });
});

describe("the check on opening", () => {
  it("is told it's the opening, and coming back isn't", () => {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const openings: (boolean | undefined)[] = [];
    const stop = watchBuild((_idle, opening) => openings.push(opening), new EventTarget(), doc);
    doc.dispatchEvent(new Event("visibilitychange"));
    stop();
    expect(openings).toEqual([true, undefined]);
  });
});

describe("the desktop app's Ask window", () => {
  it("looks for a new build only as it goes out of sight, never as it opens or comes back", () => {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const check = vi.fn();
    const stop = whenHidden(check, doc);
    expect(check).not.toHaveBeenCalled();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(check).not.toHaveBeenCalled();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(check).toHaveBeenCalledTimes(1);
    stop();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("moves on as it's put away, unless that loses or cuts off something, or it's back", async () => {
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    let running: string | null = "abc";
    let busy = false;
    let typed = false;
    const reload = vi.fn();
    const server = async () => (running ? { build: running, migrations: { ok: true } } : null);
    const page = () => "abc";
    const stop = moveOnWhenHidden(
      { server, busy: () => busy, page, loses: () => typed, reloaded: () => null, reload },
      doc,
    );
    const putAway = async (backAtOnce = false) => {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      if (backAtOnce) doc.visibilityState = "visible";
      await new Promise((r) => setTimeout(r, 0));
      doc.visibilityState = "visible";
    };
    // On the build that's running; then on an old one, while you talk or an answer is still to be
    // read aloud, with something typed, brought back before the PC answered, and with no answer.
    await putAway();
    running = "def";
    busy = true;
    await putAway();
    busy = false;
    typed = true;
    await putAway();
    typed = false;
    await putAway(true);
    running = null;
    await putAway();
    expect(reload).not.toHaveBeenCalled();
    // Skipped, it moves on the next time it's put away.
    running = "def";
    await putAway();
    expect(reload).toHaveBeenCalledExactlyOnceWith("def");
    stop();
  });
});

describe("whether you've done anything since the page came back", () => {
  it("knows of a key, a tap, a paste or a drop after it came back, for that return", () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    const returns: (() => boolean)[] = [];
    const stop = watchBuild(
      (idle) => {
        if (idle) returns.push(idle);
      },
      win,
      doc,
    );
    // Opening: nothing done yet, until something is.
    const opening = returns[0]!;
    expect(opening()).toBe(true);
    win.dispatchEvent(new Event("pointerdown"));
    expect(opening()).toBe(false);
    const away = () => {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    };
    const back = () => {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      return returns.at(-1)!;
    };
    for (const kind of ["keydown", "pointerdown", "input", "paste", "drop"]) {
      away();
      const idle = back();
      expect(idle()).toBe(true);
      // Asked again later (the server took a while to answer): it's what's happened since.
      win.dispatchEvent(new Event(kind));
      expect(idle()).toBe(false);
    }
    // Each return starts afresh; what you did after an earlier one still counts for that one.
    const first = returns.at(-1)!;
    away();
    const second = back();
    expect(second()).toBe(true);
    expect(first()).toBe(false);
    // Moving the mouse over it or scrolling isn't doing something.
    win.dispatchEvent(new Event("pointermove"));
    win.dispatchEvent(new Event("wheel"));
    expect(second()).toBe(true);
    stop();
    win.dispatchEvent(new Event("keydown"));
    expect(second()).toBe(true);
  });
});

describe("coming back to a page from before an update", () => {
  const fits = { ok: true };
  const newer = { build: "def", migrations: fits };
  const loses = (lost: boolean) => () => lost;

  it("reloads into the new build when that loses nothing", () => {
    expect(reloadOnReturn("updated", newer, null, loses(false))).toBe("def");
  });

  it("asks first when something on the page would be lost", () => {
    expect(reloadOnReturn("updated", newer, null, loses(true))).toBeNull();
  });

  it("leaves a page that's up to date, or can't be fixed by reloading, as it is", () => {
    let asked = false;
    const lost = () => {
      asked = true;
      return false;
    };
    expect(reloadOnReturn(null, { build: "abc", migrations: fits }, null, lost)).toBeNull();
    expect(
      reloadOnReturn("mismatch", { build: "def", migrations: { ok: false } }, null, lost),
    ).toBe(null);
    expect(reloadOnReturn(null, null, null, lost)).toBeNull();
    // Nothing to reload for, so the page isn't asked what it would lose.
    expect(asked).toBe(false);
  });

  it("doesn't reload again for a build it reloaded into and still came up old", () => {
    expect(reloadOnReturn("updated", newer, "def", loses(false))).toBeNull();
    // A later build is worth another try.
    expect(reloadOnReturn("updated", { build: "ghi", migrations: fits }, "def", loses(false))).toBe(
      "ghi",
    );
  });

  it("notes the build it reloads into, for this tab", () => {
    const kept = new Map<string, string>();
    const store = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    };
    let reloaded = 0;
    expect(reloadedFor(store)).toBeNull();
    reloadInto("def", undefined, store, () => {
      reloaded += 1;
    });
    expect(reloaded).toBe(1);
    expect(reloadedFor(store)).toBe("def");
    // Storage blocked: it reloads all the same, and knows of no earlier reload.
    const blocked = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    reloadInto("def", undefined, blocked, () => {
      reloaded += 1;
    });
    expect(reloaded).toBe(2);
    expect(reloadedFor(blocked)).toBeNull();
  });

  it("takes nothing more into the page it's leaving", () => {
    let blurred = 0;
    const blur = () => {
      blurred += 1;
    };
    const field = { blur } as unknown as Element;
    const page = { activeElement: field, body: { inert: false } };
    freeze(page);
    expect(blurred).toBe(1);
    expect(page.body.inert).toBe(true);
    // Nothing focused, or no body yet: nothing to do there.
    freeze({ activeElement: null, body: null });
  });
});

describe("whether reloading would lose something", () => {
  type Field = {
    type: string;
    value: string;
    defaultValue: string;
    readOnly?: boolean;
    disabled?: boolean;
  };
  const page = (...fields: Field[]) =>
    ({ querySelectorAll: () => fields }) as unknown as Pick<ParentNode, "querySelectorAll">;
  const empty = (type: string): Field => ({ type, value: "", defaultValue: "" });

  it("loses nothing when no field has anything in it and nothing's waiting to be saved", () => {
    const fields = page(empty("text"), empty("search"), empty("textarea"));
    expect(wouldLoseWork(new EventTarget(), fields)).toBe(false);
    expect(wouldLoseWork(new EventTarget(), page())).toBe(false);
  });

  it("would lose text typed into a field", () => {
    const typed = { ...empty("textarea"), value: "Ask Jarvis to" };
    expect(wouldLoseWork(new EventTarget(), page(empty("text"), typed))).toBe(true);
    expect(wouldLoseWork(new EventTarget(), page({ ...empty("text"), value: "Buy milk" }))).toBe(
      true,
    );
  });

  it("doesn't count boxes, buttons and fields you can't type into", () => {
    const fields = page(
      { ...empty("checkbox"), value: "on" },
      { ...empty("hidden"), value: "token" },
      { ...empty("range"), value: "50" },
      { ...empty("text"), value: "https://example.test", readOnly: true },
      { ...empty("text"), value: "kept", disabled: true },
      // What the page itself wrote into the field's markup is what it was given.
      { type: "text", value: "Groceries", defaultValue: "Groceries" },
    );
    expect(wouldLoseWork(new EventTarget(), fields)).toBe(false);
  });

  it("asks the page's own leave-this-page guards, as the browser does", () => {
    const win = new EventTarget();
    let unsaved = true;
    win.addEventListener("beforeunload", (e) => {
      if (unsaved) e.preventDefault();
    });
    expect(wouldLoseWork(win, page())).toBe(true);
    unsaved = false;
    expect(wouldLoseWork(win, page())).toBe(false);
  });
});

describe("a screen whose code didn't load", () => {
  const fits = { ok: true };
  const newer = { build: "def", migrations: fits };
  const loses = (lost: boolean) => () => lost;

  it("reloads into the build that's running, when that loses nothing", () => {
    expect(afterLoadFailed("abc", newer, null, loses(false))).toEqual({ reload: "def" });
  });

  it("says Hearth was updated, rather than lose what's on the page or reload twice", () => {
    expect(afterLoadFailed("abc", newer, null, loses(true))).toEqual({ why: "updated" });
    expect(afterLoadFailed("abc", newer, "def", loses(false))).toEqual({ why: "updated" });
  });

  it("knows a new build whose database didn't finish updating is still an update", () => {
    const halfway = { build: "def", migrations: { ok: false } };
    expect(afterLoadFailed("abc", halfway, null, loses(false))).toEqual({ reload: "def" });
    expect(afterLoadFailed("abc", halfway, null, loses(true))).toEqual({ why: "updated" });
  });

  it("tries again by reloading once the PC answers, since the browser keeps a failed load", () => {
    const same = { build: "abc", migrations: fits };
    expect(tryAgainBy(same, loses(false))).toBe("reload");
    // Still no answer, or something on the page would go: tries in place.
    expect(tryAgainBy(null, loses(false))).toBe("retry");
    expect(tryAgainBy(same, loses(true))).toBe("retry");
  });

  it("says it couldn't load when the PC didn't answer or runs this same build", () => {
    expect(afterLoadFailed("abc", null, null, loses(false))).toEqual({ why: "offline" });
    expect(afterLoadFailed("abc", { build: "abc", migrations: fits }, null, loses(false))).toEqual({
      why: "offline",
    });
  });
});
