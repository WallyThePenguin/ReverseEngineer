// What Hearth may ask of Chrome (D24, D52), in one place: the extension enforces these rules, and
// the Chromium Hearth's tests drive (packages/modules/src/browser/chromium.ts) enforces the very
// same ones. Nothing here uses the chrome.* APIs, so the tests can load this file as it is.

/** The link's protocol version. Raise it when the server and the extension must change together. */
export const PROTOCOL = 2;

/**
 * The protocol commands Hearth may send to a tab: what it needs to look at, stream and operate a
 * page. None of the protocol's cookie, storage, network or other-tab commands.
 */
export const ALLOWED = new Set([
  "Page.navigate",
  "Page.reload",
  "Page.getFrameTree",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.createIsolatedWorld",
  "Page.captureScreenshot",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
  "Page.getLayoutMetrics",
  "Page.enable",
  "Page.handleJavaScriptDialog",
  "Runtime.evaluate",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Emulation.setFocusEmulationEnabled",
]);

/** The one command that works while a dialog is open; anything else would wait for an answer. */
export const DIALOG_SAFE = new Set(["Page.handleJavaScriptDialog"]);

/** Commands that leave the page, during which a "leave site?" dialog can open. */
export const NAVIGATIONS = new Set(["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"]);

/** An error with a code Hearth's server acts on, like "dialog_open". */
export class HearthError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {string} url */
export function assertWebUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HearthError("not_allowed", `${url} isn't a web address.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new HearthError("not_allowed", "Jarvis only opens http and https pages.");
}

/**
 * Checks a command before it's sent: allowed at all, web addresses only, and scripts only in an
 * isolated world Hearth made, which the page's own scripts can't see.
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {Set<unknown> | undefined} worlds the isolated worlds Hearth made in this tab
 */
export function checkCommand(method, params, worlds) {
  if (!ALLOWED.has(method))
    throw new HearthError("not_allowed", `${method} isn't something Hearth is allowed to do.`);
  if (method === "Page.navigate") assertWebUrl(String(params.url ?? ""));
  if (method === "Runtime.evaluate" && !worlds?.has(params.contextId))
    throw new HearthError(
      "not_allowed",
      "Scripts may only run in an isolated world Hearth created.",
    );
}

/** @typedef {{ type: string, message: string, url: string, defaultPrompt?: string }} Dialog */

/**
 * The error a call gets while a dialog is open. The dialog's own words stay out of it: they're
 * the page's, and browser_tabs shows them where Jarvis knows they came from a page.
 * @param {Dialog} dialog
 */
export function dialogOpen(dialog) {
  const kind = dialog.type === "beforeunload" ? '"leave site?"' : dialog.type;
  return new HearthError(
    "dialog_open",
    `A ${kind} dialog is open on this page, and nothing else happens there until it's answered. Answer it with browser_dialog (browser_tabs shows what it says).`,
  );
}

/**
 * The dialogs open in Hearth's tabs, from the page domain's events. A call made while one is open
 * fails at once, and so does one already waiting when a dialog opens: a click that opens an alert
 * doesn't return until the alert is answered.
 */
export class Dialogs {
  constructor() {
    /** @type {Map<number, Dialog>} */
    this.open = new Map();
    /** @type {Map<number, Set<(err: Error) => void>>} */
    this.waiting = new Map();
  }

  /** @param {number} tabId */
  get(tabId) {
    return this.open.get(tabId) ?? null;
  }

  /** @param {number} tabId @param {Dialog} dialog */
  opened(tabId, dialog) {
    this.open.set(tabId, dialog);
    for (const fail of [...(this.waiting.get(tabId) ?? [])]) fail(dialogOpen(dialog));
  }

  /** @param {number} tabId */
  closed(tabId) {
    this.open.delete(tabId);
  }

  /**
   * Sends a command, unless a dialog is in the way.
   * @template T
   * @param {number} tabId
   * @param {string} method
   * @param {() => Promise<T>} send
   * @returns {Promise<T>}
   */
  guard(tabId, method, send) {
    if (DIALOG_SAFE.has(method)) return send();
    const now = this.open.get(tabId);
    if (now) return Promise.reject(dialogOpen(now));
    return new Promise((resolve, reject) => {
      const set = this.waiting.get(tabId) ?? new Set();
      this.waiting.set(tabId, set);
      const done = () => {
        set.delete(fail);
        if (set.size === 0) this.waiting.delete(tabId);
      };
      /** @param {Error} err */
      const fail = (err) => {
        done();
        reject(err);
      };
      set.add(fail);
      send().then(
        (value) => {
          done();
          resolve(value);
        },
        (err) => {
          done();
          reject(err);
        },
      );
    });
  }
}

/**
 * Whether the extension answers a dialog by itself: only "leave site?" while Hearth navigates one
 * of Jarvis's own tabs. In a tab you handed over, the unsaved work may be yours, so Jarvis has to
 * answer it with browser_dialog.
 * @param {Dialog} dialog
 * @param {{ navigating: boolean, own: boolean }} tab
 */
export function answersItself(dialog, tab) {
  return dialog.type === "beforeunload" && tab.navigating && tab.own;
}
