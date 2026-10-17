// Drives a tab through Chrome's debugging protocol, within the rules in rules.js: only the
// commands Hearth needs to look at, stream and operate a page, and scripts only in isolated worlds
// Hearth created, which the page's own scripts can't see. Frames from other sites run in their own
// processes and come in as child sessions of the tab (B1), set up the same way. While attached,
// Chrome shows its "debugging this browser" bar, so idle tabs are let go after a few minutes.

import {
  answersItself,
  CHILD_SETUP,
  checkCommand,
  Dialogs,
  HearthError,
  NAVIGATIONS,
  SESSION_SETUP,
} from "./rules.js";
import { isOwn, mayUse } from "./tabs.js";

const IDLE_DETACH_MS = 5 * 60_000;

const attached = new Set();
/** Attaches under way: two calls at once share one instead of knocking each other off. */
/** @type {Map<number, Promise<void>>} */
const attaching = new Map();
/** Isolated worlds Hearth made, per tab and frame session ("12" or "12/<session>"). */
/** @type {Map<string, Set<unknown>>} */
const worlds = new Map();
/** Each tab's child sessions (frames from other sites), and the frame each is for. */
/** @type {Map<number, Map<string, string>>} */
const children = new Map();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const idle = new Map();
/** Dialogs open in Hearth's tabs. */
export const dialogs = new Dialogs();
/** The session each open dialog came from, where its answer goes. */
/** @type {Map<number, string | undefined>} */
const dialogSession = new Map();
/** Tabs Hearth is navigating right now, and how many navigations are under way in each. */
/** @type {Map<number, number>} */
const navigating = new Map();
/** Told when Hearth lets go of a tab, or Chrome does. */
/** @type {(tabId: number, reason: string) => void} */
let lost = () => {};

/** @param {number} tabId @param {string | undefined} sessionId */
const worldKey = (tabId, sessionId) => (sessionId ? `${tabId}/${sessionId}` : String(tabId));

/**
 * Turns on what the server's driver relies on. A step that fails (an older Chrome without child
 * sessions, say) leaves the rest on.
 * @param {chrome.debugger.DebuggerSession} target
 * @param {[string, Record<string, unknown>][]} steps
 */
async function setUp(target, steps) {
  for (const [method, params] of steps)
    await chrome.debugger.sendCommand(target, method, params).catch(() => {});
}

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
  await setUp({ tabId }, SESSION_SETUP);
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

/** Forgets what was known about a tab's session. @param {number} tabId */
function clear(tabId) {
  clearTimeout(idle.get(tabId));
  idle.delete(tabId);
  for (const key of [...worlds.keys()])
    if (key === String(tabId) || key.startsWith(`${tabId}/`)) worlds.delete(key);
  children.delete(tabId);
  navigating.delete(tabId);
  dialogs.closed(tabId);
  dialogSession.delete(tabId);
}

/** @param {number} tabId */
export async function detach(tabId, reason = "released") {
  const was = attached.delete(tabId);
  clear(tabId);
  if (!was) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
  lost(tabId, reason);
}

/** @param {number} tabId */
function touch(tabId) {
  clearTimeout(idle.get(tabId));
  idle.set(
    tabId,
    setTimeout(() => {
      // An open dialog would go unnoticed while detached, so the tab stays attached until it's answered.
      if (dialogs.get(tabId)) touch(tabId);
      else void detach(tabId, "idle");
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
 * @param {string} [sessionId] a frame's child session in this tab
 */
export async function cdp(tabId, method, params = {}, sessionId = undefined) {
  if (sessionId !== undefined && !children.get(tabId)?.has(sessionId))
    throw new HearthError("gone", "That frame isn't on the page any more.");
  // A dialog is answered where it opened, which may be a frame's session.
  const session =
    method === "Page.handleJavaScriptDialog" && sessionId === undefined
      ? dialogSession.get(tabId)
      : sessionId;
  const key = worldKey(tabId, session);
  checkCommand(method, params, worlds.get(key));
  if (!(await mayUse(tabId)))
    throw new HearthError("not_yours", "That tab isn't Pip's and wasn't handed to it.");
  await attach(tabId);
  touch(tabId);
  const nav = NAVIGATIONS.has(method);
  if (nav) countNavigation(tabId, 1);
  try {
    const result = await dialogs.guard(tabId, method, () =>
      chrome.debugger.sendCommand({ tabId, sessionId: session }, method, params),
    );
    if (method === "Page.createIsolatedWorld") {
      const id = /** @type {{ executionContextId: number }} */ (result).executionContextId;
      const set = worlds.get(key) ?? new Set();
      set.add(id);
      worlds.set(key, set);
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

/**
 * A tab's frames from other sites, for a server that wasn't listening when they came.
 * @param {number} tabId
 */
export function framesOf(tabId) {
  return [...(children.get(tabId) ?? [])].map(([sessionId, targetId]) => ({ sessionId, targetId }));
}

/** The dialog open in a tab, as the server sees it. @param {number} tabId */
export function dialogIn(tabId) {
  return dialogs.get(tabId);
}

/** Each tab's page events, handled one after another. */
/** @type {Map<number, Promise<void>>} */
const pageEvents = new Map();

/**
 * Keeps track of a tab's dialogs and frames from its events, and answers "leave site?" by itself
 * while Hearth navigates one of Jarvis's own tabs. A tab's events are handled in order, so a
 * dialog closed at once (by you, or by another debugger) never outlasts its own closing.
 * @param {number} tabId
 * @param {string | undefined} sessionId the frame session it came from, if not the tab's own
 * @param {string} method
 * @param {any} params
 * @returns {Promise<void>}
 */
export function onPageEvent(tabId, sessionId, method, params) {
  const ahead = pageEvents.get(tabId) ?? Promise.resolve();
  const next = ahead.then(() => pageEvent(tabId, sessionId, method, params)).catch(() => {});
  pageEvents.set(tabId, next);
  void next.then(() => {
    if (pageEvents.get(tabId) === next) pageEvents.delete(tabId);
  });
  return next;
}

/** @param {number} tabId @param {string | undefined} sessionId @param {string} method @param {any} params */
async function pageEvent(tabId, sessionId, method, params) {
  if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") {
    const child = params.sessionId;
    const map = children.get(tabId) ?? new Map();
    map.set(child, String(params.targetInfo?.targetId ?? ""));
    children.set(tabId, map);
    await setUp({ tabId, sessionId: child }, CHILD_SETUP);
  } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
    children.get(tabId)?.delete(params.sessionId);
    worlds.delete(worldKey(tabId, params.sessionId));
  } else if (method === "Page.javascriptDialogOpening") {
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
        .sendCommand({ tabId, sessionId }, "Page.handleJavaScriptDialog", { accept: true })
        .catch(() => {});
      return;
    }
    dialogSession.set(tabId, sessionId);
    dialogs.opened(tabId, dialog);
  } else if (method === "Page.javascriptDialogClosed") {
    dialogs.closed(tabId);
    dialogSession.delete(tabId);
  }
}

/** Events that change what Hearth knows about a tab's frames or dialogs. */
export const TRACKED = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
]);

/**
 * @param {(tabId: number, reason: string) => void} onLost Called when Hearth lets go of a tab
 * (idle, released, closed), or when you cancel the bar or the tab goes.
 */
export function watchDetach(onLost) {
  lost = onLost;
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    attaching.delete(source.tabId);
    clear(source.tabId);
    onLost(source.tabId, reason);
  });
}
