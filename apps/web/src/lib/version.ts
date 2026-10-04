// Whether the open page is the Hearth that's running (D57). The page knows the build it came
// from; /api/health/deep says the build the server started with and whether its database fits.

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
 * Runs `check` now, every few minutes while the page is in view, when it comes back into view,
 * and when the network is back. A hidden page doesn't ask: it asks as soon as it's back, and an
 * open tab alone shouldn't keep your sign-in alive (D56). Returns the cleanup.
 */
export function watchBuild(
  check: () => void,
  win: EventTarget = window,
  doc: EventTarget & { visibilityState: DocumentVisibilityState } = document,
): () => void {
  const ifVisible = () => {
    if (doc.visibilityState === "visible") check();
  };
  check();
  const timer = setInterval(ifVisible, CHECK_EVERY_MS);
  doc.addEventListener("visibilitychange", ifVisible);
  win.addEventListener("online", check);
  return () => {
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", ifVisible);
    win.removeEventListener("online", check);
  };
}
