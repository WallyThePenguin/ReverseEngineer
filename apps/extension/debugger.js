// Drives a tab through Chrome's debugging protocol, within the rules in rules.js: only the
// commands Hearth needs to look at, stream and operate a page, and scripts only in isolated worlds
// Hearth created, which the page's own scripts can't see. While attached, Chrome shows its
// "debugging this browser" bar, so idle tabs are let go after a few minutes.

import { answersItself, checkCommand, Dialogs, HearthError, NAVIGATIONS } from "./rules.js";
import { isOwn, mayUse } from "./tabs.js";

const IDLE_DETACH_MS = 5 * 60_000;

const attached = new Set();
/** Attaches under way: two calls at once share one instead of knocking each other off. */
/** @type {Map<number, Promise<void>>} */
const attaching = new Map();
/** Isolated worlds Hearth made, per tab; scripts may run only there. */
/** @type {Map<number, Set<unknown>>} */
const worlds = new Map();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const idle = new Map();
/** Dialogs open in Hearth's tabs. */
export const dialogs = new Dialogs();
/** Tabs Hearth is navigating right now, and how many navigations are under way in each. */
/** @type {Map<number, number>} */
const navigating = new Map();

/** @param {number} tabId */
async function attachNow(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    // After a service worker restart the old session may still be ours.
    if (!message.includes("already attached")) throw new Error(message);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.debugger.attach({ tabId }, "1.3").catch(() => {
      throw new Error("Another debugger (DevTools?) is attached to this tab. Close it and retry.");
    });
  }
  attached.add(tabId);
  // Dialogs and page events are reported only with the page domain on.
  await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
}

/** @param {number} tabId */
function attach(tabId) {
  if (attached.has(tabId)) return Promise.resolve();
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = attachNow(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

/** @param {number} tabId */
export async function detach(tabId) {
  clearTimeout(idle.get(tabId));
  idle.delete(tabId);
  worlds.delete(tabId);
  dialogs.closed(tabId);
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

/** @param {number} tabId */
function touch(tabId) {
  clearTimeout(idle.get(tabId));
  idle.set(
    tabId,
    setTimeout(() => {
      // An open dialog would go unnoticed while detached, so the tab stays attached until it's answered.
      if (dialogs.get(tabId)) touch(tabId);
      else void detach(tabId);
    }, IDLE_DETACH_MS),
  );
}

/** @param {number} tabId @param {number} by */
function countNavigation(tabId, by) {
  const n = (navigating.get(tabId) ?? 0) + by;
  if (n > 0) navigating.set(tabId, n);
  else navigating.delete(tabId);
}

/**
 * @param {number} tabId
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 */
export async function cdp(tabId, method, params = {}) {
  checkCommand(method, params, worlds.get(tabId));
  if (!(await mayUse(tabId)))
    throw new HearthError("not_yours", "That tab isn't Jarvis's and wasn't handed to it.");
  await attach(tabId);
  touch(tabId);
  const nav = NAVIGATIONS.has(method);
  if (nav) countNavigation(tabId, 1);
  try {
    const result = await dialogs.guard(tabId, method, () =>
      chrome.debugger.sendCommand({ tabId }, method, params),
    );
    if (method === "Page.createIsolatedWorld") {
      const id = /** @type {{ executionContextId: number }} */ (result).executionContextId;
      const set = worlds.get(tabId) ?? new Set();
      set.add(id);
      worlds.set(tabId, set);
    }
    if (method === "Page.handleJavaScriptDialog") dialogs.closed(tabId);
    return result;
  } catch (err) {
    if (method === "Page.handleJavaScriptDialog") {
      // Answered already, by you in Chrome: there's nothing left to answer.
      dialogs.closed(tabId);
      if (String(err instanceof Error ? err.message : err).includes("No dialog is showing"))
        throw new HearthError("no_dialog", "There's no dialog open in this tab any more.");
    }
    throw err;
  } finally {
    if (nav) countNavigation(tabId, -1);
  }
}

/** Each tab's page events, handled one after another. */
/** @type {Map<number, Promise<void>>} */
const pageEvents = new Map();

/**
 * Keeps track of a tab's dialogs from its page events, and answers "leave site?" by itself while
 * Hearth navigates one of Jarvis's own tabs. A tab's events are handled in order, so a dialog
 * closed at once (by you, or by another debugger) never outlasts its own closing.
 * @param {number} tabId
 * @param {string} method
 * @param {any} params
 * @returns {Promise<void>}
 */
export function onPageEvent(tabId, method, params) {
  const ahead = pageEvents.get(tabId) ?? Promise.resolve();
  const next = ahead.then(() => pageEvent(tabId, method, params)).catch(() => {});
  pageEvents.set(tabId, next);
  void next.then(() => {
    if (pageEvents.get(tabId) === next) pageEvents.delete(tabId);
  });
  return next;
}

/** @param {number} tabId @param {string} method @param {any} params */
async function pageEvent(tabId, method, params) {
  if (method === "Page.javascriptDialogOpening") {
    const dialog = {
      type: String(params?.type ?? "alert"),
      message: String(params?.message ?? "").slice(0, 2000),
      url: String(params?.url ?? ""),
      defaultPrompt: String(params?.defaultPrompt ?? ""),
    };
    const moving = navigating.has(tabId);
    const own = await isOwn(tabId);
    if (answersItself(dialog, { navigating: moving, own })) {
      await chrome.debugger
        .sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true })
        .catch(() => {});
      return;
    }
    dialogs.opened(tabId, dialog);
  } else if (method === "Page.javascriptDialogClosed") {
    dialogs.closed(tabId);
  }
}

/** @param {(tabId: number) => void} onLost Called when you cancel the bar or the tab goes. */
export function watchDetach(onLost) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    attaching.delete(source.tabId);
    worlds.delete(source.tabId);
    navigating.delete(source.tabId);
    dialogs.closed(source.tabId);
    clearTimeout(idle.get(source.tabId));
    idle.delete(source.tabId);
    onLost(source.tabId);
  });
}
