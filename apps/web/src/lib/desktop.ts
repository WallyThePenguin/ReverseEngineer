// Hearth's Windows app (D53) shows these same pages in its own window, with "HearthDesktop/<version>"
// added to the user agent. There, Windows notifications come from the app, so the web's own
// install and notification prompts stay out of the way.

export const inDesktopApp = (ua = navigator.userAgent) => /\bHearthDesktop\//.test(ua);

/** The desktop app's two small windows: quick capture, and asking Jarvis by typing. */
export type MiniPage = "capture" | "ask";

export function miniPage(loc: { pathname: string; search: string }): MiniPage | null {
  const path = loc.pathname.replace(/\/+$/, "");
  if (path === "/capture") return "capture";
  if (path === "/chat" && new URLSearchParams(loc.search).get("compact") === "1") return "ask";
  return null;
}

/**
 * Hides the desktop app's small window this page is in. Elsewhere there's nothing to close, and
 * a browser would only ask to open the app.
 */
export function closeMiniWindow() {
  if (inDesktopApp()) location.href = "hearth://close";
}

/** Splits quick capture's text into a task: the first line is its title, the rest its notes. */
export function captureToTask(text: string): { title: string; body?: string } | null {
  const [first = "", ...rest] = text.trim().split(/\r?\n/);
  const title = first.trim().slice(0, 500);
  if (!title) return null;
  const body = rest.join("\n").trim();
  return body ? { title, body } : { title };
}
