// What Hearth may ask of Chrome (D24, D52), in one place: the extension enforces these rules, and
// the Chromium Hearth's tests drive (packages/modules/src/browser/chromium.ts) enforces the very
// same ones. Nothing here uses the chrome.* APIs, so the tests can load this file as it is.

/** The link's protocol version. Raise it when the server and the extension must change together. */
export const PROTOCOL = 3;

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
  // B1, the server's driver (D52): load progress, the accessibility tree, where things are on
  // the page by their node numbers, and Hearth's own isolated worlds. Frames from other sites
  // come in as child sessions of the tab.
  "Page.setLifecycleEventsEnabled",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getContentQuads",
  "DOM.getBoxModel",
  "DOM.getNodeForLocation",
  "DOM.scrollIntoViewIfNeeded",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.releaseObjectGroup",
  "Log.enable",
  "Target.setAutoAttach",
]);

/**
 * What a tab's debugger session turns on as Hearth attaches (B1): the page's events (dialogs,
 * navigations, load progress), the browser's log, the accessibility tree, focus emulation (so a
 * tab behind another still takes keys and draws for a screenshot), and child sessions for frames
 * from other sites, which run in their own processes. Not Runtime: pages can tell when it's on.
 * @type {[string, Record<string, unknown>][]}
 */
export const SESSION_SETUP = [
  ["Page.enable", {}],
  ["Page.setLifecycleEventsEnabled", { enabled: true }],
  ["Log.enable", {}],
  ["Accessibility.enable", {}],
  ["Emulation.setFocusEmulationEnabled", { enabled: true }],
  [
    "Target.setAutoAttach",
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe" }],
    },
  ],
];

/**
 * The same for a frame's child session, which shares the tab's focus and log.
 * @type {[string, Record<string, unknown>][]}
 */
export const CHILD_SETUP = [
  ["Page.enable", {}],
  ["Page.setLifecycleEventsEnabled", { enabled: true }],
  ["Accessibility.enable", {}],
  [
    "Target.setAutoAttach",
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe" }],
    },
  ],
];

/**
 * Page events the server has no use for, which the extension keeps to itself: the accessibility
 * tree's change notices, and the protocol's bookkeeping of script contexts.
 */
export const QUIET_EVENTS = new Set([
  "Accessibility.nodesUpdated",
  "Accessibility.loadComplete",
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
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
 * isolated world Hearth made, which the page's own scripts can't see. A page's elements are
 * handed out only inside those worlds, so nothing Hearth holds belongs to the page's own
 * scripts. Frames from other sites come only as flat child sessions, never paused.
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {Set<unknown> | undefined} worlds the isolated worlds Hearth made in this tab or frame
 */
export function checkCommand(method, params, worlds) {
  if (!ALLOWED.has(method))
    throw new HearthError("not_allowed", `${method} isn't something Hearth is allowed to do.`);
  if (method === "Page.navigate") assertWebUrl(String(params.url ?? ""));
  const outsideWorlds =
    (method === "Runtime.evaluate" && !worlds?.has(params.contextId)) ||
    (method === "Runtime.callFunctionOn" &&
      (params.objectId !== undefined || !worlds?.has(params.executionContextId))) ||
    (method === "DOM.resolveNode" && !worlds?.has(params.executionContextId));
  if (outsideWorlds)
    throw new HearthError(
      "not_allowed",
      "Scripts may only run in an isolated world Hearth created.",
    );
  if (
    method === "Target.setAutoAttach" &&
    (params.flatten !== true || params.waitForDebuggerOnStart === true)
  )
    throw new HearthError("not_allowed", "Frames are attached only as flat, running sessions.");
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
