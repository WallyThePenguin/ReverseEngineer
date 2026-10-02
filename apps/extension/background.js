// The Hearth extension (D24): lets Jarvis use this Chrome. It keeps one WebSocket open to your
// Hearth server, takes commands only from there, and reports Jarvis's tabs and page events back.

import { cdp, detach, watchDetach } from "./debugger.js";
import {
  closeTab,
  forget,
  hand,
  listTabs,
  mayUse,
  openTab,
  showTab,
  tabState,
  windowClosed,
} from "./tabs.js";

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_URL = "http://127.0.0.1:4400";

/** @type {WebSocket | null} */
let socket = null;
let connected = false;
let lastError = "";

async function config() {
  return /** @type {{ hearthUrl: string, token: string }} */ (
    await chrome.storage.local.get({ hearthUrl: DEFAULT_URL, token: "" })
  );
}

/** @param {unknown} message */
function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function badge() {
  void chrome.action.setBadgeText({ text: connected ? "" : "off" });
  void chrome.action.setBadgeBackgroundColor({ color: "#9a3412" });
}

let tabsTimer = 0;
function pushTabs() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => send({ type: "tabs", tabs: await listTabs() }), 150);
}

/** @type {Record<string, (params: any) => Promise<unknown>>} */
const methods = {
  "tabs.list": () => listTabs(),
  "tabs.open": async ({ url, show }) => {
    const tab = await openTab(url, show !== false);
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
  cdp: ({ tabId, method, params }) => cdp(tabId, method, params),
};

/** @param {any} msg */
async function onMessage(msg) {
  if (msg.type === "ping") return send({ type: "pong" });
  if (msg.type === "welcome") {
    connected = true;
    lastError = "";
    badge();
    return pushTabs();
  }
  if (msg.type === "rejected") {
    lastError = msg.reason ?? "Hearth refused the pairing code.";
    return socket?.close();
  }
  if (msg.type !== "call") return;
  const run = methods[msg.method];
  try {
    if (!run) throw new Error(`Unknown request ${msg.method}`);
    send({ type: "result", id: msg.id, result: (await run(msg.params ?? {})) ?? null });
  } catch (err) {
    send({ type: "result", id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
}

async function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const { hearthUrl, token } = await config();
  if (!token) {
    lastError = "Not paired yet. Open the extension's options and paste the code from Hearth.";
    return badge();
  }
  const url = `${hearthUrl.replace(/\/$/, "").replace(/^http/, "ws")}/api/browser/bridge`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = async () => {
    ws.send(JSON.stringify({ type: "hello", token, version: VERSION }));
  };
  ws.onmessage = (e) => void onMessage(JSON.parse(String(e.data)));
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    connected = false;
    badge();
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
  if (source.tabId !== undefined) send({ type: "event", tabId: source.tabId, method, params });
});
watchDetach((tabId) => {
  send({ type: "detached", tabId });
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
chrome.windows.onRemoved.addListener((windowId) => void windowClosed(windowId));

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
      own: msg.tabId !== undefined && own.includes(msg.tabId),
      handed: msg.tabId !== undefined && handed.includes(msg.tabId),
    });
  })();
  return true;
});

// Stay connected: on start, on browser start, and every 30 seconds if the link dropped.
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.alarms.create("hearth-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());
badge();
void connect();
