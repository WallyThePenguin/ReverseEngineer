// Settings' sections, and a way to open Settings at one of them (the set-up checklist does).

import { createRoot, createSignal } from "solid-js";
import { layout } from "./panes.ts";

export const SETTINGS_SECTIONS = [
  { id: "jarvis", label: "Jarvis" },
  { id: "rules", label: "Rules" },
  { id: "chrome", label: "Chrome" },
  { id: "desktop", label: "Desktop app" },
  { id: "phone", label: "Phone" },
  { id: "google", label: "Google" },
  { id: "slack", label: "Slack" },
  { id: "github", label: "GitHub" },
  { id: "notion", label: "Notion" },
  { id: "import", label: "Import" },
  { id: "signins", label: "Sign-ins" },
  { id: "routines", label: "Routines" },
  { id: "passkeys", label: "Passkeys" },
  { id: "health", label: "Health" },
  { id: "coming", label: "Coming up" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The section Settings should scroll to once it's showing; it clears itself when done. */
export const settingsTarget = createRoot(() => {
  const [get, set] = createSignal<SettingsSection | null>(null);
  return { get, set };
});

/** Hearth's window on this PC asked to be connected again (its sign-in page's button, D69). */
export const windowAsked = createRoot(() => {
  const [get, set] = createSignal(false);
  return { get, set };
});

/** Opens Settings at a section: next to the pane you're in, or in it on a phone. */
export function openSettings(section: SettingsSection, from?: number) {
  settingsTarget.set(section);
  if (from === undefined) layout.open({ view: "settings" });
  else layout.show({ view: "settings" }, from);
}
