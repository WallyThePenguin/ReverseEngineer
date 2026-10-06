// How notifications can reach this device. On an iPhone or iPad, Apple lets only web apps on the
// Home Screen have them: in a Safari tab there's no way to turn them on, so Hearth shows the one
// step that makes it possible instead of a button that can't work.

import { inDesktopApp } from "./desktop.ts";

/**
 * "push": the browser's own. "desktop": Hearth's Windows app's. "home-screen": none until Hearth
 * is added to the Home Screen and opened from there. "none": not on this device.
 */
export type AlertsHere = "push" | "desktop" | "home-screen" | "none";

export function alertsHere(d: {
  ua: string;
  /** navigator.maxTouchPoints: an iPad's Safari says it's a Mac, and a Mac has no touch screen. */
  touchPoints: number;
  /** Opened from the Home Screen. */
  standalone: boolean;
  /** The browser can take push notifications. */
  push: boolean;
}): AlertsHere {
  if (inDesktopApp(d.ua)) return "desktop";
  if (d.push) return "push";
  const apple =
    /\b(iPhone|iPad|iPod)\b/.test(d.ua) || (/Macintosh/.test(d.ua) && d.touchPoints > 1);
  return apple && !d.standalone ? "home-screen" : "none";
}

/** Hearth was opened from the Home Screen (or installed as an app). */
export const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/** This device's way, read once: none of it changes while the page is open. */
export const alertsOnThisDevice = (): AlertsHere =>
  alertsHere({
    ua: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints ?? 0,
    standalone: installed(),
    push: "serviceWorker" in navigator && "PushManager" in window,
  });
