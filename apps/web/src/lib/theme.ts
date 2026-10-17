// This device's theme: one of Nook's six, or the system's own choice between Light and Dark (the
// default). It's set as data-theme on <html>, which picks the theme's stylesheet
// (styles/themes/). public/theme-boot.js sets it before the page draws; this keeps it current.

import { createEffect, createRoot, createSignal } from "solid-js";
import { NOOK_THEMES } from "../styles/themes.ts";

export type ThemeId = (typeof NOOK_THEMES)[number]["id"];
export type ThemeChoice = ThemeId | "system";

/** Where the choice is kept, on this device only; public/theme-boot.js reads it too. */
export const THEME_KEY = "hearth.theme";

const IDS: readonly string[] = NOOK_THEMES.map((t) => t.id);
const isTheme = (v: unknown): v is ThemeId => typeof v === "string" && IDS.includes(v);

/** The theme shown for a choice: the system's asks for Dark or Light. */
export function themeFor(choice: ThemeChoice, systemDark: boolean): ThemeId {
  if (choice !== "system") return choice;
  return systemDark ? "dark" : "light";
}

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : "system";
  } catch {
    // Storage turned off (a private window): the system's theme.
    return "system";
  }
}

/** How long a theme change crossfades (Nook's dur-base). */
const FADE_MS = 220;

export const theme = createRoot(() => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const [choice, setChoice] = createSignal<ThemeChoice>(stored());
  const [systemDark, setSystemDark] = createSignal(media.matches);
  media.addEventListener("change", (e) => setSystemDark(e.matches));
  // Another window of Hearth on this device chose one.
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY) setChoice(stored());
  });
  const shown = () => themeFor(choice(), systemDark());

  createEffect(() => {
    const id = shown();
    const root = document.documentElement;
    root.dataset.theme = id;
    // The phone's status bar and the window's title bar take the theme's canvas.
    const canvas = NOOK_THEMES.find((t) => t.id === id)!.canvas;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", canvas);
  });

  let fading: number | undefined;
  /** Chooses a theme for this device; the page crossfades to it. */
  const choose = (next: ThemeChoice) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {}
    const root = document.documentElement;
    root.dataset.themeFade = "";
    window.clearTimeout(fading);
    fading = window.setTimeout(() => delete root.dataset.themeFade, FADE_MS);
    setChoice(next);
  };

  return { choice, shown, choose };
});
