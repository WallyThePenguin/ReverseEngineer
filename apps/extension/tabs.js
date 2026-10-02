// Which tabs Jarvis may use: the ones it opened in its own "Jarvis" window, and the ones you
// handed it. Kept in session storage so a service worker restart doesn't forget them.

const GROUP_TITLE = "Jarvis";

/** @typedef {{ windowId: number | null, own: number[], handed: number[] }} TabState */

/** @returns {Promise<TabState>} */
export async function tabState() {
  return /** @type {TabState} */ (
    await chrome.storage.session.get({ windowId: null, own: [], handed: [] })
  );
}

/** @param {Partial<TabState>} patch */
async function save(patch) {
  await chrome.storage.session.set(patch);
}

/** @param {string} url */
export function assertWebUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} isn't a web address.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Jarvis only opens http and https pages.");
}

/** @param {chrome.tabs.Tab} tab @param {boolean} handed */
function info(tab, handed) {
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active,
    handed,
    loading: tab.status === "loading",
  };
}

export async function listTabs() {
  const { own, handed } = await tabState();
  const out = [];
  for (const [ids, isHanded] of /** @type {const} */ ([
    [own, false],
    [handed, true],
  ])) {
    for (const id of ids) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab) out.push(info(tab, isHanded));
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

/** @param {number} tabId @param {number} windowId */
async function addToGroup(tabId, windowId) {
  const [group] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
  if (group) {
    await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "purple" });
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
  const mine = tabs.flatMap((t) => (t.id !== undefined && own.includes(t.id) ? [t.id] : []));
  if (mine.length === tabs.length) return;
  restoring = { windowId: -1, until: 0 };
  const [first, ...rest] = mine;
  if (first === undefined) return save({ windowId: null });
  const win = await chrome.windows.create({ ...WINDOW, tabId: first });
  if (!win?.id) return;
  if (rest.length) await chrome.tabs.move(rest, { windowId: win.id, index: -1 });
  await save({ windowId: win.id });
  for (const id of mine) await addToGroup(id, win.id);
}

/** Opens a page in Jarvis's window, making the window (behind yours) if it's gone. */
export function openTab(/** @type {string} */ url, show = true) {
  assertWebUrl(url);
  return inTurn(async () => {
    let windowId = await jarvisWindow();
    let tab;
    if (windowId === null) {
      const yours = await chrome.windows.getAll({ windowTypes: ["normal"] });
      const win = await chrome.windows.create({ ...WINDOW, url });
      if (!win?.id || !win.tabs?.[0]) throw new Error("Chrome didn't open a window.");
      windowId = win.id;
      tab = win.tabs[0];
      await save({ windowId });
      if (yours.length === 0) restoring = { windowId, until: Date.now() + RESTORE_MS };
    } else {
      tab = await chrome.tabs.create({ windowId, url, active: show });
    }
    if (tab.id === undefined) throw new Error("Chrome didn't open a tab.");
    await addToGroup(tab.id, windowId);
    const { own } = await tabState();
    await save({ own: [...own, tab.id] });
    await leaveRestored();
    return info(await chrome.tabs.get(tab.id), false);
  });
}

/** @param {number} tabId */
export async function closeTab(tabId) {
  if (!(await isOwn(tabId))) throw new Error("Jarvis can only close tabs it opened.");
  await chrome.tabs.remove(tabId).catch(() => {});
  await forget(tabId);
}

/** Brings one of Jarvis's tabs to the front of Jarvis's window, so it draws. */
export async function showTab(/** @type {number} */ tabId) {
  if (!(await isOwn(tabId))) throw new Error("Only Jarvis's own tabs can be switched to.");
  await chrome.tabs.update(tabId, { active: true });
}

/** @param {number} tabId */
export async function hand(tabId) {
  const { handed, own } = await tabState();
  if (!handed.includes(tabId) && !own.includes(tabId)) await save({ handed: [...handed, tabId] });
}

/** @param {number} tabId */
export async function forget(tabId) {
  const { own, handed, windowId } = await tabState();
  await save({
    own: own.filter((id) => id !== tabId),
    handed: handed.filter((id) => id !== tabId),
    windowId,
  });
}

/** @param {number} windowId */
export async function windowClosed(windowId) {
  const state = await tabState();
  if (state.windowId === windowId) await save({ windowId: null });
}
