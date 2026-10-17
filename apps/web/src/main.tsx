import { render } from "solid-js/web";
import "./index.css";
import { miniPage } from "./lib/desktop.ts";
// Keeps the page on this device's theme (public/theme-boot.js set it before the first paint).
import "./lib/theme.ts";
import { App } from "./shell/App.tsx";
import { MiniApp } from "./shell/Mini.tsx";

// A page back from the browser's back/forward cache would come back live, with what Jarvis read
// on it still marked: Hearth always loads afresh instead.
addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

// The Windows app's small windows (/capture, /chat?compact=1) get just their page, not the shell.
const mini = miniPage(location);
render(() => (mini ? <MiniApp page={mini} /> : <App />), document.getElementById("root")!);

// The service worker makes Hearth installable on a phone, opens it at once, and shows its
// notifications. The dev server skips it, so a stale copy never hides a change.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
