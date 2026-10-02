// Drives a tab through Chrome's debugging protocol. Only the commands Hearth needs to look at,
// stream and operate a page are allowed: none of the protocol's cookie, storage, network or
// other-tab commands. Scripts run only in isolated worlds Hearth created, which the page's own
// scripts can't see. While attached, Chrome shows its "debugging this browser" bar, so idle tabs
// are let go after a few minutes.

import { assertWebUrl, mayUse } from "./tabs.js";

const IDLE_DETACH_MS = 5 * 60_000;

const ALLOWED = new Set([
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
  "Runtime.evaluate",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Emulation.setFocusEmulationEnabled",
]);

const attached = new Set();
/** Isolated worlds Hearth made, per tab; scripts may run only there. */
const worlds = new Map();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const idle = new Map();

/** @param {number} tabId */
async function attach(tabId) {
  if (attached.has(tabId)) return;
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
}

/** @param {number} tabId */
export async function detach(tabId) {
  clearTimeout(idle.get(tabId));
  idle.delete(tabId);
  worlds.delete(tabId);
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

/** @param {number} tabId */
function touch(tabId) {
  clearTimeout(idle.get(tabId));
  idle.set(
    tabId,
    setTimeout(() => void detach(tabId), IDLE_DETACH_MS),
  );
}

/**
 * @param {number} tabId
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 */
export async function cdp(tabId, method, params = {}) {
  if (!ALLOWED.has(method)) throw new Error(`${method} isn't something Hearth is allowed to do.`);
  if (!(await mayUse(tabId))) throw new Error("That tab isn't Jarvis's and wasn't handed to it.");
  if (method === "Page.navigate") assertWebUrl(String(params.url ?? ""));
  if (method === "Runtime.evaluate" && !worlds.get(tabId)?.has(params.contextId))
    throw new Error("Scripts may only run in an isolated world Hearth created.");
  await attach(tabId);
  touch(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, method, params);
  if (method === "Page.createIsolatedWorld") {
    const id = /** @type {{ executionContextId: number }} */ (result).executionContextId;
    if (!worlds.has(tabId)) worlds.set(tabId, new Set());
    worlds.get(tabId).add(id);
  }
  return result;
}

/** @param {(tabId: number) => void} onLost Called when you cancel the bar or the tab goes. */
export function watchDetach(onLost) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    worlds.delete(source.tabId);
    clearTimeout(idle.get(source.tabId));
    idle.delete(source.tabId);
    onLost(source.tabId);
  });
}
