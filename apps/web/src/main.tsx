import { render } from "solid-js/web";
import "./index.css";
import { miniPage } from "./lib/desktop.ts";
import { App } from "./shell/App.tsx";
import { MiniApp } from "./shell/Mini.tsx";

// The Windows app's small windows (/capture, /chat?compact=1) get just their page, not the shell.
const mini = miniPage(location);
render(() => (mini ? <MiniApp page={mini} /> : <App />), document.getElementById("root")!);

// The service worker makes Hearth installable on a phone and shows its notifications. The dev
// server skips it, so a stale copy never hides a change.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
