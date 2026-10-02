// Pairing: where Hearth is, and the code from Hearth's Settings. The code is kept in this
// browser's extension storage and only ever sent to that address.

const form = /** @type {HTMLFormElement} */ (document.getElementById("form"));
const url = /** @type {HTMLInputElement} */ (document.getElementById("url"));
const token = /** @type {HTMLInputElement} */ (document.getElementById("token"));
const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));

async function showStatus() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  statusEl.textContent = s.connected ? "Connected." : s.error || "Not connected yet.";
  statusEl.className = `status ${s.connected ? "on" : "off"}`;
}

const saved = /** @type {{ hearthUrl: string, token: string }} */ (
  await chrome.storage.local.get({ hearthUrl: "http://127.0.0.1:4400", token: "" })
);
url.value = saved.hearthUrl;
token.placeholder = saved.token ? "Saved. Paste a new code to replace it." : "";

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const patch = { hearthUrl: url.value.trim() || "http://127.0.0.1:4400" };
  if (token.value.trim()) Object.assign(patch, { token: token.value.trim() });
  await chrome.storage.local.set(patch);
  token.value = "";
  statusEl.textContent = "Connecting…";
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(() => void showStatus(), 1500);
});
await showStatus();
setInterval(() => void showStatus(), 3000);

export {};
