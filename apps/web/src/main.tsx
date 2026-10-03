import { render } from "solid-js/web";
import "./index.css";
import { App } from "./shell/App.tsx";

render(() => <App />, document.getElementById("root")!);

// The service worker makes Hearth installable on a phone and shows its notifications. The dev
// server skips it, so a stale copy never hides a change.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}
