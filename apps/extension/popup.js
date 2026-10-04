// The toolbar popup: whether Hearth is connected, and handing this tab to Jarvis or taking it back.

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const OUTDATED =
  "Hearth is newer than this extension. Open chrome://extensions and press reload on Hearth.";

/** @param {{ connected: boolean, error: string, outdated?: boolean, own: boolean, handed: boolean }} s @param {number | undefined} tabId */
function render(s, tabId) {
  $("status").textContent = s.connected ? "Connected to your Hearth" : "Not connected";
  $("status").className = `status ${s.connected ? "on" : "off"}`;
  $("error").textContent = s.outdated ? OUTDATED : s.error;
  $("hand").hidden = tabId === undefined || s.own || s.handed;
  $("take").hidden = !s.handed;
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const tabId = tab?.id;
const ask = async (/** @type {string} */ type) =>
  render(await chrome.runtime.sendMessage({ type, tabId }), tabId);

$("hand").addEventListener("click", () => void ask("hand"));
$("take").addEventListener("click", () => void ask("take-back"));
$("options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
await ask("status");

export {};
