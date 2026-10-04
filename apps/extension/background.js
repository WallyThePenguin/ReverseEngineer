// The Hearth extension (D24): lets Jarvis use this Chrome. It keeps one WebSocket open to your
// Hearth server, takes commands only from there, and reports Jarvis's tabs and page events back.

import { cdp, detach, dialogs, framesOf, onPageEvent, TRACKED, watchDetach } from "./debugger.js";
import { PROTOCOL, QUIET_EVENTS } from "./rules.js";
import {
  adopt,
  closeTab,
  forget,
  hand,
  listTabs,
  mayUse,
  navCommitted,
  navFailed,
  noticeTab,
  openTab,
  showTab,
  tabState,
  windowClosed,
} from "./tabs.js";

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_URL = "http://127.0.0.1:4400";
// When Hearth is newer than this extension, it reloads itself from its folder at most this often:
// enough to pick up an update, never a loop if the folder wasn't updated.
const RELOAD_EVERY_MS = 10 * 60_000;

/** @type {WebSocket | null} */
let socket = null;
let connected = false;
let lastError = "";
let outdated = false;
// After the link drops (Hearth restarted, say), try again soon, then less often.
let retryMs = 1000;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let retryTimer;

async function config() {
  return /** @type {{ hearthUrl: string, token: string }} */ (
    await chrome.storage.local.get({ hearthUrl: DEFAULT_URL, token: "" })
  );
}

/** @param {unknown} message @param {WebSocket | null} ws */
function send(message, ws = socket) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function badge() {
  void chrome.action.setBadgeText({ text: connected ? (outdated ? "old" : "") : "off" });
  void chrome.action.setBadgeBackgroundColor({ color: "#9a3412" });
}

const tabs = () => listTabs((tabId) => dialogs.get(tabId));

let tabsTimer = 0;
function pushTabs() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => send({ type: "tabs", tabs: await tabs() }), 150);
}

/** @type {Record<string, (params: any) => Promise<unknown>>} */
const methods = {
  "tabs.list": () => tabs(),
  // `group` names the piece of work (a Jarvis turn) the tab is for: its tabs share a group.
  "tabs.open": async ({ url, show, group }) => {
    const work = typeof group === "string" && group ? group.slice(0, 64) : null;
    const tab = await openTab(url, show !== false, work);
    pushTabs();
    return tab;
  },
  "tabs.close": async ({ tabId }) => {
    await detach(tabId);
    await closeTab(tabId);
    pushTabs();
    return { closed: true };
  },
  "tabs.release": async ({ tabId }) => {
    await detach(tabId);
    await forget(tabId);
    pushTabs();
    return { released: true };
  },
  "tabs.show": async ({ tabId }) => {
    await showTab(tabId);
    return { shown: true };
  },
  "tabs.frames": async ({ tabId }) => {
    if (!(await mayUse(tabId))) return [];
    return framesOf(tabId);
  },
  // `sessionId` addresses a frame from another site inside the tab (B1).
  cdp: async ({ tabId, method, params, sessionId }) => {
    const session = typeof sessionId === "string" ? sessionId : undefined;
    if (method !== "Page.handleJavaScriptDialog") return cdp(tabId, method, params, session);
    // Answering a dialog (or finding it gone) changes what the tab list says about it.
    try {
      return await cdp(tabId, method, params, session);
    } finally {
      pushTabs();
    }
  },
};

/** Hearth speaks a newer protocol: reload from the extension's folder, which an update refreshed. */
/** @param {unknown} protocol */
async function checkProtocol(protocol) {
  outdated = typeof protocol === "number" && protocol > PROTOCOL;
  badge();
  if (!outdated) return;
  const { reloadedAt } = await chrome.storage.local.get({ reloadedAt: 0 });
  if (Date.now() - Number(reloadedAt) > RELOAD_EVERY_MS) {
    await chrome.storage.local.set({ reloadedAt: Date.now() });
    chrome.runtime.reload();
  }
}

/** @param {any} msg @param {WebSocket} ws the link it came on, where its answer goes */
async function onMessage(msg, ws) {
  if (msg.type === "ping") return send({ type: "pong" }, ws);
  if (msg.type === "welcome") {
    connected = true;
    lastError = "";
    retryMs = 1000;
    pushTabs();
    return checkProtocol(msg.protocol);
  }
  if (msg.type === "update") return checkProtocol(msg.protocol);
  if (msg.type === "rejected") {
    lastError = msg.reason ?? "Hearth refused the pairing code.";
    return socket?.close();
  }
  if (msg.type !== "call") return;
  const run = methods[msg.method];
  try {
    if (!run) throw new Error(`Unknown request ${msg.method}`);
    send({ type: "result", id: msg.id, result: (await run(msg.params ?? {})) ?? null }, ws);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const code = /** @type {{ code?: unknown }} */ (err)?.code;
    send(
      { type: "result", id: msg.id, error, code: typeof code === "string" ? code : undefined },
      ws,
    );
  }
}

async function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const { hearthUrl, token } = await config();
  // Chrome starting runs this twice at once; the first one to get here makes the link.
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  if (!token) {
    lastError = "Not paired yet. Open the extension's options and paste the code from Hearth.";
    return badge();
  }
  const url = `${hearthUrl.replace(/\/$/, "").replace(/^http/, "ws")}/api/browser/bridge`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", token, version: VERSION, protocol: PROTOCOL }));
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    onMessage(msg, ws).catch(() => {});
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    socket = null;
    connected = false;
    badge();
    // A wrong pairing code, or another Chrome took over the link: leave it to the alarm.
    if (e.code === 4000 || e.code === 4001) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void connect(), retryMs);
    retryMs = Math.min(retryMs * 2, 15_000);
  };
  ws.onerror = () => {
    lastError = lastError || `Can't reach Hearth at ${hearthUrl}.`;
  };
}

function reconnect() {
  socket?.close();
  socket = null;
  void connect();
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  // A frame's own session says which: the server's driver keeps each frame apart.
  const sessionId = source.sessionId;
  if (!QUIET_EVENTS.has(method)) send({ type: "event", tabId, sessionId, method, params });
  if (TRACKED.has(method))
    onPageEvent(tabId, sessionId, method, params)
      .then(() => {
        if (method.startsWith("Page.")) pushTabs();
      })
      .catch(() => {});
});
watchDetach((tabId, reason) => {
  send({ type: "detached", tabId, reason });
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!(await mayUse(tabId))) return;
  await forget(tabId);
  pushTabs();
});
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if ((change.url || change.title || change.status) && (await mayUse(tabId))) pushTabs();
});
chrome.tabs.onActivated.addListener(() => pushTabs());
chrome.tabs.onCreated.addListener((tab) => noticeTab(tab));
chrome.windows.onRemoved.addListener((windowId) => void windowClosed(windowId));

// Pop-ups and links that open a new tab or window from a page (D52). Only these: a tab's
// openerTabId alone isn't enough, since Chrome gives one to tabs you open yourself too (Duplicate
// names the tab you were on), and those are yours.
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  adopt(d.sourceTabId, d.tabId)
    .then((adopted) => {
      if (adopted) pushTabs();
    })
    .catch(() => {});
});
chrome.webNavigation.onErrorOccurred.addListener(async (d) => {
  if (d.frameId !== 0 || !(await mayUse(d.tabId))) return;
  navFailed(d.tabId, d.error);
  pushTabs();
});
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) navCommitted(d.tabId);
});

// From the popup and the options page.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === "hand") await hand(msg.tabId);
    if (msg.type === "take-back") {
      await detach(msg.tabId);
      await forget(msg.tabId);
    }
    if (msg.type === "hand" || msg.type === "take-back") pushTabs();
    if (msg.type === "reconnect") reconnect();
    const { own, handed } = await tabState();
    reply({
      connected,
      error: connected ? "" : lastError,
      outdated,
      own: msg.tabId !== undefined && own.includes(msg.tabId),
      handed: msg.tabId !== undefined && handed.includes(msg.tabId),
    });
  })().catch(() => reply({ connected, error: lastError, outdated, own: false, handed: false }));
  return true;
});

// Stay connected: on start, on browser start, soon after the link drops, and every 30 seconds.
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.alarms.create("hearth-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());
badge();
void connect();
