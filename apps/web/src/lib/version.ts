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

/** What counts as you doing something on the page: a key, a tap or click, a paste, a drop. */
const TOUCHES = ["keydown", "pointerdown", "input", "paste", "drop"] as const;

/**
 * Runs `check` now, then every few minutes while the page is in view, when it comes back into
 * view, and when the network is back while it's in view. A hidden page doesn't ask (not even when
 * a laptop wakes and its network comes back): it asks as soon as it's back, and an open tab alone
 * shouldn't keep your sign-in alive (D56). When it's for the page coming back, `check` is given
 * `idle`, which says, when asked, whether you've done nothing on the page since it came back: a
 * tap on Done or a paste then mustn't be lost to a reload. Returns the cleanup.
 */
export function watchBuild(
  check: (idle?: () => boolean) => void,
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
  check();
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
 * Reloads the page into `build`, noting it first. The page takes nothing more meanwhile: what
 * you'd type or click in it until the new one is there would go with it.
 */
export function reloadInto(
  build: string,
  store?: Pick<Storage, "setItem">,
  reload: () => void = () => {
    freeze();
    location.reload();
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
