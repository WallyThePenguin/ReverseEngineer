// Pairing: where Hearth is, and the code from Hearth's Settings. The code is kept in this
// browser's extension storage and only ever sent to that address.

const form = /** @type {HTMLFormElement} */ (document.getElementById("form"));
const url = /** @type {HTMLInputElement} */ (document.getElementById("url"));
const token = /** @type {HTMLInputElement} */ (document.getElementById("token"));
const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));

async function showStatus() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  statusEl.textContent = s.outdated
    ? "Connected, but Nook is newer than this extension. Reload it at chrome://extensions."
    : s.connected
      ? "Connected."
      : s.error || "Not connected yet.";
  statusEl.className = `status ${s.connected ? "on" : "off"}`;
}

// Listening before anything is awaited: a press that comes before the saved values are read
// still saves, rather than sending the form as a page load and losing the code.
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

const saved = /** @type {{ hearthUrl: string, token: string }} */ (
  await chrome.storage.local.get({ hearthUrl: "http://127.0.0.1:4400", token: "" })
);
// What you've typed already stays.
if (!url.value) url.value = saved.hearthUrl;
token.placeholder = saved.token ? "Saved. Paste a new code to replace it." : "";
await showStatus();
setInterval(() => void showStatus(), 3000);

export {};
