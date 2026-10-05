// Which tabs Jarvis may use: the ones it opened in its own "Jarvis" window, the ones you handed
// it, and the pop-ups and new tabs those open (D52). Kept in session storage so a service worker
// restart doesn't forget them.

import { assertWebUrl, HearthError } from "./rules.js";

const GROUP_TITLE = "Jarvis";
/** Each piece of work's group gets one of these, so groups side by side tell apart. */
const COLORS = /** @type {const} */ (["blue", "cyan", "green", "orange", "pink", "yellow", "red"]);
/** How many pieces of work's groups are remembered. */
const KEPT_GROUPS = 20;

/**
 * `from` is the tab each adopted pop-up came from; `groups` the tab group of each piece of work
 * (a Jarvis turn), by its key.
 * @typedef {{ windowId: number | null, own: number[], handed: number[], from: Record<string, number>, groups: Record<string, number> }} TabState
 */

/** @returns {Promise<TabState>} */
export async function tabState() {
  return /** @type {TabState} */ (
    await chrome.storage.session.get({ windowId: null, own: [], handed: [], from: {}, groups: {} })
  );
}

// Every change to the saved state reads it and writes it back, one change at a time, so a pop-up
// adopted while a tab closes doesn't undo one of the two.
let editing = Promise.resolve();
/** @param {(state: TabState) => Partial<TabState> | null | undefined} change */
function edit(change) {
  const run = editing.then(async () => {
    const patch = change(await tabState());
    if (patch) await chrome.storage.session.set(patch);
  });
  editing = run.catch(() => {});
  return run;
}

/** Why the last page a tab tried to load didn't, until the next one does. */
/** @type {Map<number, string>} */
const navErrors = new Map();

/** @param {number} tabId @param {string} error */
export function navFailed(tabId, error) {
  navErrors.set(tabId, error);
}

/** @param {number} tabId */
export function navCommitted(tabId) {
  navErrors.delete(tabId);
}

/** @typedef {{ type: string, message: string, url: string, defaultPrompt?: string }} Dialog */

/**
 * @param {chrome.tabs.Tab} tab
 * @param {boolean} handed
 * @param {Dialog | null} [dialog]
 * @param {number | null} [openedFrom] the tab it was adopted from, for a pop-up
 */
function info(tab, handed, dialog = null, openedFrom = null) {
  const id = tab.id ?? -1;
  return {
    tabId: id,
    windowId: tab.windowId,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active,
    handed,
    loading: tab.status === "loading",
    // Not Chrome's own openerTabId: a tab Jarvis opens itself gets one too (the tab in front).
    openerTabId: openedFrom,
    dialog,
    error: navErrors.get(id) ?? null,
  };
}

/** @param {(tabId: number) => Dialog | null} [dialogOf] what's open in each tab, if anything */
export async function listTabs(dialogOf = () => null) {
  const { own, handed, from } = await tabState();
  const out = [];
  for (const [ids, isHanded] of /** @type {const} */ ([
    [own, false],
    [handed, true],
  ])) {
    for (const id of ids) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab) out.push(info(tab, isHanded, dialogOf(id), from[id] ?? null));
    }
  }
  return out;
}

/** @param {number} tabId */
export async function mayUse(tabId) {
  const { own, handed } = await tabState();
  return own.includes(tabId) || handed.includes(tabId);
}

/** @param {number} tabId */
export async function isOwn(tabId) {
  return (await tabState()).own.includes(tabId);
}

async function jarvisWindow() {
  const { windowId } = await tabState();
  if (windowId === null) return null;
  const win = await chrome.windows.get(windowId).catch(() => null);
  return win ? windowId : null;
}

/**
 * The group a tab joins in Jarvis's window: its piece of work's, if it has one and that's still
 * there, or else the plain "Jarvis" group.
 * @param {number} windowId @param {boolean} fresh a window Jarvis just made
 * @param {string | null} work the piece of work (a Jarvis turn) the tab is for
 */
async function groupFor(windowId, fresh, work) {
  if (work !== null) {
    const known = (await tabState()).groups[work];
    const group = known === undefined ? null : await chrome.tabGroups.get(known).catch(() => null);
    return group?.windowId === windowId ? group : null;
  }
  // In a window Jarvis just made, a "Jarvis" group already there came back with your last session.
  if (fresh) return null;
  const [group] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
  return group ?? null;
}

/**
 * Puts a tab in a group in Jarvis's window. Each piece of work gets a group of its own, named for
 * when it started, so you can see what each one opened.
 * @param {number} tabId @param {number} windowId @param {boolean} fresh a window Jarvis just made
 * @param {string | null} work the piece of work (a Jarvis turn) the tab is for
 */
async function addToGroup(tabId, windowId, fresh = false, work = null) {
  const group = await groupFor(windowId, fresh, work);
  if (group) {
    await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  if (work === null) {
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "purple" });
    return;
  }
  const at = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hash = [...work].reduce((n, c) => n + c.charCodeAt(0), 0);
  const color = COLORS[hash % COLORS.length] ?? "blue";
  await chrome.tabGroups.update(groupId, { title: `${GROUP_TITLE} ${at}`, color });
  await edit(({ groups }) => ({
    groups: Object.fromEntries([...Object.entries(groups), [work, groupId]].slice(-KEPT_GROUPS)),
  }));
}

// Changes to Jarvis's window happen one at a time, so two pages opened at once share a window.
let queue = Promise.resolve();
/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
function inTurn(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

// When Chrome has no windows open and is set to continue where you left off, it brings your last
// session back into the next window that opens, which is Jarvis's. That window is then yours:
// Jarvis moves its own tabs to a new window. Restored tabs can arrive a moment later, so tabs
// landing in a window Jarvis just made are checked for a while.
const RESTORE_MS = 15_000;
let restoring = { windowId: -1, until: 0 };

/** @param {chrome.tabs.Tab} tab */
export function noticeTab(tab) {
  if (tab.windowId === restoring.windowId && Date.now() < restoring.until)
    void inTurn(leaveRestored);
}

const WINDOW = /** @type {const} */ ({ focused: false, state: "normal", width: 1280, height: 900 });

async function leaveRestored() {
  const { windowId, own } = await tabState();
  if (windowId === null || windowId !== restoring.windowId) return;
  const tabs = await chrome.tabs.query({ windowId });
  const isOwn = (/** @type {chrome.tabs.Tab} */ t) => t.id !== undefined && own.includes(t.id);
  const mine = tabs.flatMap((t) => (t.id !== undefined && isOwn(t) ? [t.id] : []));
  // Tabs opened from Jarvis's tabs join its group; restored ones don't.
  const groups = new Set(tabs.flatMap((t) => (isOwn(t) && t.groupId !== -1 ? [t.groupId] : [])));
  if (tabs.every((t) => isOwn(t) || groups.has(t.groupId))) return;
  restoring = { windowId: -1, until: 0 };
  const [first, ...rest] = mine;
  if (first === undefined) return edit(() => ({ windowId: null }));
  const win = await chrome.windows.create({ ...WINDOW, tabId: first });
  const moved = win?.id;
  if (moved === undefined) return;
  if (rest.length) await chrome.tabs.move(rest, { windowId: moved, index: -1 });
  await edit(() => ({ windowId: moved }));
  for (const id of mine) await addToGroup(id, moved);
}

/**
 * Opens a page in Jarvis's window, making the window (without focus) if it's gone.
 * @param {string} url
 * @param {string | null} work the piece of work (a Jarvis turn) it's for, whose group it joins
 */
export function openTab(url, show = true, work = null) {
  assertWebUrl(url);
  return inTurn(async () => {
    let windowId = await jarvisWindow();
    const made = windowId === null;
    let tab;
    if (windowId === null) {
      const yours = await chrome.windows.getAll({ windowTypes: ["normal"] });
      const win = await chrome.windows.create({ ...WINDOW, url });
      const created = win?.id;
      if (created === undefined || !win?.tabs?.[0]) throw new Error("Chrome didn't open a window.");
      windowId = created;
      tab = win.tabs[0];
      await edit(() => ({ windowId: created }));
      if (yours.length === 0) restoring = { windowId, until: Date.now() + RESTORE_MS };
    } else {
      tab = await chrome.tabs.create({ windowId, url, active: show });
    }
    const tabId = tab.id;
    if (tabId === undefined) throw new Error("Chrome didn't open a tab.");
    await addToGroup(tabId, windowId, made, work);
    await edit(({ own }) => ({ own: [...own, tabId] }));
    await leaveRestored();
    return info(await chrome.tabs.get(tabId), false);
  });
}

/** @param {number} tabId */
export async function closeTab(tabId) {
  if (!(await isOwn(tabId)))
    throw new HearthError("not_yours", "Jarvis can only close tabs it opened.");
  await chrome.tabs.remove(tabId).catch(() => {});
  await forget(tabId);
}

/** Brings one of Jarvis's tabs to the front of Jarvis's window, so it draws. */
export async function showTab(/** @type {number} */ tabId) {
  if (!(await isOwn(tabId)))
    throw new HearthError("not_yours", "Only Jarvis's own tabs can be switched to.");
  await chrome.tabs.update(tabId, { active: true });
}

/** @param {number} tabId */
export function hand(tabId) {
  return edit(({ handed, own }) =>
    handed.includes(tabId) || own.includes(tabId) ? null : { handed: [...handed, tabId] },
  );
}

/**
 * A pop-up or new tab a page opened from one of Jarvis's tabs is Jarvis's too: one opened from
 * its own tab is its own, and one opened from a tab you handed it counts as handed. Tabs you open
 * yourself stay yours. Says whether the tab was adopted just now.
 * @param {number} openerTabId
 * @param {number} tabId
 */
export async function adopt(openerTabId, tabId) {
  /** @type {"own" | "handed" | null} */
  let adopted = null;
  await edit(({ own, handed, from }) => {
    if (own.includes(tabId) || handed.includes(tabId)) return null;
    const opened = { ...from, [tabId]: openerTabId };
    if (own.includes(openerTabId)) {
      adopted = "own";
      return { own: [...own, tabId], from: opened };
    }
    if (handed.includes(openerTabId)) {
      adopted = "handed";
      return { handed: [...handed, tabId], from: opened };
    }
    return null;
  });
  if (adopted === "own") await joinGroup(tabId, openerTabId);
  return adopted !== null;
}

/**
 * A tab Jarvis adopts in its own window joins the group of the tab that opened it, or else the
 * "Jarvis" group; a pop-up window has none.
 * @param {number} tabId @param {number} openerTabId
 */
async function joinGroup(tabId, openerTabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const windowId = await jarvisWindow();
  if (!tab || windowId === null || tab.windowId !== windowId || tab.groupId !== -1) return;
  const opener = await chrome.tabs.get(openerTabId).catch(() => null);
  if (opener && opener.windowId === windowId && opener.groupId !== -1) {
    await chrome.tabs.group({ groupId: opener.groupId, tabIds: [tabId] }).catch(() => {});
    return;
  }
  await addToGroup(tabId, windowId).catch(() => {});
}

/** @param {number} tabId */
export function forget(tabId) {
  navErrors.delete(tabId);
  return edit(({ own, handed, from }) => {
    const { [tabId]: _gone, ...rest } = from;
    return {
      own: own.filter((id) => id !== tabId),
      handed: handed.filter((id) => id !== tabId),
      from: rest,
    };
  });
}

/** @param {number} windowId */
export function windowClosed(windowId) {
  return edit((state) => (state.windowId === windowId ? { windowId: null } : null));
}
