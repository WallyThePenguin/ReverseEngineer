// Whether the open page is the Hearth that's running (D57). The page knows the build it came
// from; /api/health/deep says the build the server started with and whether its database fits.
// A page you come back to (the desktop app's window opened from the tray, a tab, the phone app)
// moves to a new build by itself when that loses nothing; otherwise it says Hearth was updated.

/** What the page reads from /api/health/deep. */
export interface ServerBuild {
  build: string | null;
  migrations: { ok: boolean } | null;
}

export type Notice = "updated" | "mismatch" | null;

/** The build this page came from: vite.config.ts stamps it into index.html. */
export function pageBuild(doc: Pick<Document, "querySelector"> = document): string | null {
  return doc.querySelector<HTMLMetaElement>('meta[name="hearth-build"]')?.content || null;
}

export function noticeFor(mine: string | null, server: ServerBuild | null): Notice {
  if (!server) return null;
  if (server.migrations && !server.migrations.ok) return "mismatch";
  if (mine && server.build && server.build !== mine) return "updated";
  return null;
}

/** How often an open page asks which build is running. */
export const CHECK_EVERY_MS = 5 * 60_000;

/**
 * The address the page opened at, before anything on it tidied the address (App.tsx drops
 * ?connect=desktop once it's read): reloading on opening goes back there. Read as the page's code
 * loads, before anything is drawn.
 */
export const openedAt = typeof location === "undefined" ? undefined : location.href;

/** What counts as you doing something on the page: a key, a tap or click, a paste, a drop. */
const TOUCHES = ["keydown", "pointerdown", "input", "paste", "drop"] as const;

/**
 * Runs `check` now, then every few minutes while the page is in view, when it comes back into
 * view, and when the network is back while it's in view. A hidden page doesn't ask (not even when
 * a laptop wakes and its network comes back): it asks as soon as it's back, and an open tab alone
 * shouldn't keep your sign-in alive (D56). When it's for the page opening (it opens from the last
 * page seen, which may be from before an update: sw.js) or coming back, `check` is given `idle`,
 * which says, when asked, whether you've done nothing on the page since: a tap on Done or a paste
 * then mustn't be lost to a reload. The first check is also told it's the opening. Returns the
 * cleanup.
 */
export function watchBuild(
  check: (idle?: () => boolean, opening?: boolean) => void,
  win: EventTarget = window,
  doc: EventTarget & { visibilityState: DocumentVisibilityState } = document,
): () => void {
  let touches = 0;
  const touch = () => {
    touches += 1;
  };
  const again = () => {
    if (doc.visibilityState === "visible") check();
  };
  const back = () => {
    if (doc.visibilityState !== "visible") return;
    const at = touches;
    check(() => touches === at);
  };
  check(() => touches === 0, true);
  const timer = setInterval(again, CHECK_EVERY_MS);
  doc.addEventListener("visibilitychange", back);
  win.addEventListener("online", again);
  // Seen first, before anything on the page can stop it going further.
  for (const kind of TOUCHES) win.addEventListener(kind, touch, { capture: true });
  return () => {
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", back);
    win.removeEventListener("online", again);
    for (const kind of TOUCHES) win.removeEventListener(kind, touch, { capture: true });
  };
}

/**
 * Runs `check` each time the page goes out of sight: the desktop app's Ask window looks for a new
 * build then, not as you open it to type (Mini.tsx). Returns the cleanup.
 */
export function whenHidden(
  check: () => void,
  doc: EventTarget & { visibilityState: DocumentVisibilityState } = document,
): () => void {
  const hidden = () => {
    if (doc.visibilityState === "hidden") check();
  };
  doc.addEventListener("visibilitychange", hidden);
  return () => doc.removeEventListener("visibilitychange", hidden);
}

/** What the Ask window's put-away check reads and does; tests give their own. */
export interface PutAway {
  /** The build running on the PC, or null when it didn't answer. */
  server: () => Promise<ServerBuild | null>;
  /** Something a reload would cut off: you talking, or an answer still to be read aloud. */
  busy: () => boolean;
  page?: () => string | null;
  loses?: () => boolean;
  reloaded?: () => string | null;
  reload?: (build: string) => void;
}

/**
 * The desktop app's Ask window keeps its page between uses, and is opened to type into at once,
 * so it never reloads as it opens or comes back: as it's put away (window.rs tells it), it asks
 * which build is running and moves on to a newer one when that loses and cuts off nothing. One
 * skipped then waits for the next time it's put away, as does one brought back meanwhile.
 * Returns the cleanup.
 */
export function moveOnWhenHidden(
  o: PutAway,
  doc: EventTarget & { visibilityState: DocumentVisibilityState } = document,
): () => void {
  const {
    page = () => pageBuild(),
    loses = () => wouldLoseWork(),
    reloaded = () => reloadedFor(),
    reload = (build: string) => reloadInto(build),
  } = o;
  return whenHidden(async () => {
    const server = await o.server();
    if (!server) return;
    const now = noticeFor(page(), server);
    const into = reloadOnReturn(now, server, reloaded(), () => loses() || o.busy());
    if (into && doc.visibilityState === "hidden") reload(into);
  }, doc);
}

/**
 * The build a page that's just come back into view should reload into now, or null to show the
 * notice instead. Only when it's out of date and reloading loses nothing, and not when it already
 * reloaded for that build and still came up old (the service worker's saved page, when the PC was
 * slow to answer): then it says so rather than reload each time you look.
 */
export function reloadOnReturn(
  notice: Notice,
  server: ServerBuild | null,
  reloadedFor: string | null,
  wouldLose: () => boolean,
): string | null {
  const build = server?.build;
  if (notice !== "updated" || !build || build === reloadedFor) return null;
  return wouldLose() ? null : build;
}

/**
 * What to do when a screen's code didn't load (opened the first time on a page from before an
 * update, whose files the update replaced): reload into the build that's running, once per build
 * and only when that loses nothing; otherwise say why, "updated" (reload to open it) or "offline"
 * (the PC didn't answer, or answered with this same build). The builds are compared directly: a
 * new build whose database didn't finish updating has still replaced this page's files.
 */
export function afterLoadFailed(
  mine: string | null,
  server: ServerBuild | null,
  reloadedFor: string | null,
  wouldLose: () => boolean,
): { reload: string } | { why: "updated" | "offline" } {
  const build = server?.build;
  if (!mine || !build || build === mine) return { why: "offline" };
  if (build === reloadedFor || wouldLose()) return { why: "updated" };
  return { reload: build };
}

/**
 * What "Try again" does on a screen whose code the PC didn't send: a browser keeps a failed load
 * of a file for good, so once the PC answers, reloading the page is what fetches it afresh. Not
 * when that would lose something on the page: then it tries in place, and Reload is beside it.
 */
export function tryAgainBy(server: ServerBuild | null, wouldLose: () => boolean) {
  return server && !wouldLose() ? "reload" : "retry";
}

/** Fields you click rather than type into. */
const CLICKED = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * Whether reloading the page now would lose something: what its own "leave this page?" guards
 * hold, asked as the browser asks them (a note or a board not saved yet: doc.ts, wholeSave.ts),
 * or text in a field (a message half-written, a task not added yet). A field filled in by the
 * page counts too, since that can't be told from typing; the notice then asks first.
 */
export function wouldLoseWork(
  win: EventTarget = window,
  doc: Pick<ParentNode, "querySelectorAll"> = document,
): boolean {
  const leaving = new Event("beforeunload", { cancelable: true });
  win.dispatchEvent(leaving);
  if (leaving.defaultPrevented) return true;
  const fields = doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  return Array.from(fields).some(
    (f) => !CLICKED.has(f.type) && !f.readOnly && !f.disabled && f.value !== f.defaultValue,
  );
}

/** Where a tab notes the build it reloaded itself into (see reloadOnReturn). */
const RELOADED_FOR = "hearth-reloaded-for";

export function reloadedFor(store?: Pick<Storage, "getItem">): string | null {
  try {
    return (store ?? sessionStorage).getItem(RELOADED_FOR);
  } catch {
    return null;
  }
}

/**
 * Reloads the page into `build` (at `href`, if given), noting it first. The page takes nothing
 * more meanwhile: what you'd type or click in it until the new one is there would go with it.
 */
export function reloadInto(
  build: string,
  href?: string,
  store?: Pick<Storage, "setItem">,
  reload: () => void = () => {
    freeze();
    reloadPage(href);
  },
): void {
  try {
    (store ?? sessionStorage).setItem(RELOADED_FOR, build);
  } catch {
    // Storage blocked: it reloads all the same.
  }
  reload();
}

/** Leaves the page as it is but takes no more input into it: nothing has focus, nothing's live. */
export function freeze(
  doc: { activeElement: Element | null; body: { inert: boolean } | null } = document,
): void {
  (doc.activeElement as HTMLElement | null)?.blur?.();
  if (doc.body) doc.body.inert = true;
}

// Where the service worker keeps the last page seen, and notes the last build seen to start here
// (sw.js: SHELL, STARTED). Only that build opens before the PC answers.
const SHELL = "hearth-shell-v3";
const STARTED = "/.started";

let marks: Promise<void> = Promise.resolve();
/** One at a time, in order: forgetting the build for a reload mustn't land before noting it. */
function inTurn(change: (shell: Cache) => Promise<unknown>): Promise<void> {
  marks = marks
    .then(async () => {
      if (typeof caches !== "undefined") await change(await caches.open(SHELL));
    })
    .catch(() => {});
  return marks;
}

/**
 * Notes that this build has started here: next time it opens before the PC answers (sw.js). Only
 * for a page the service worker gave, which keeps the files that came with it.
 */
export function markStarted(build = pageBuild()): void {
  if (!build || !navigator.serviceWorker?.controller) return;
  void inTurn((shell) => shell.put(STARTED, new Response(build)));
}

/** The next page opened comes from the PC rather than from what's kept, when it answers in time. */
export const forgetStarted = (): Promise<void> => inTurn((shell) => shell.delete(STARTED));

/**
 * Reloads the page from the PC (at `href`, if given): a reload is for a new build, or for files
 * that didn't load, so it mustn't open the page kept from before.
 */
export function reloadPage(href?: string): void {
  void forgetStarted().then(() => {
    const here = (url: string) => url.split("#")[0];
    if (href && here(href) !== here(location.href)) location.replace(href);
    else location.reload();
  });
}
