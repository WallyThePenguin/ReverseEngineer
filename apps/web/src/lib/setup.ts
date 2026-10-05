// The "Set up Hearth" checklist: what a working Hearth needs, read from system.status.

import { jarvisLiveness } from "./jarvis-health.ts";
import type { SettingsSection } from "./settingsNav.ts";
import type { SystemStatus } from "./types.ts";

export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  /** What to do, or what's wrong, while it isn't done. */
  detail: string;
  /** Where in Settings it's set up. */
  section: SettingsSection;
}

/**
 * The steps, in the order worth doing them; empty when the server doesn't say. `asOf` is when that
 * status was read, so an old answer doesn't age into "Jarvis stopped".
 */
export function setupSteps(s: SystemStatus | undefined, asOf = Date.now()): SetupStep[] {
  if (!s?.setup) return [];
  const jarvis = jarvisLiveness({ data: s, dataUpdatedAt: asOf });
  const backup = s.components.backup;
  return [
    {
      id: "jarvis",
      label: "Jarvis is running",
      done: s.jarvisAlive !== null && !jarvis.unwell,
      detail:
        s.jarvisAlive === null
          ? "Jarvis hasn't started yet. Start the Jarvis service on the PC."
          : jarvis.downSince
            ? "Jarvis stopped. Hearth is trying to restart it."
            : (jarvis.detail ?? ""),
      section: "jarvis",
    },
    {
      id: "google",
      label: "Connect Google for mail and calendar",
      done: s.setup.google,
      detail: "Jarvis reads and sorts your mail and keeps your calendar.",
      section: "google",
    },
    {
      id: "chrome",
      label: "Pair Chrome so Jarvis can use the web as you",
      done: s.setup.chrome,
      detail: "Install Hearth's extension in Chrome and pair it with a code.",
      section: "chrome",
    },
    {
      id: "phone",
      label: "Get alerts on your phone",
      done: s.setup.phone,
      detail: "Open Hearth on your phone, add it to the home screen, and turn on notifications.",
      section: "phone",
    },
    {
      id: "desktop",
      label: "Pair the desktop app for dictation and Talk",
      done: s.setup.desktop,
      detail: "Install Hearth's desktop app on the PC and pair it with a code.",
      section: "desktop",
    },
    {
      id: "backup",
      label: "Backups run every night",
      done: backup?.status === "ok",
      detail: backup ? `Backups need a look: ${backup.detail}` : "No backup has run yet.",
      section: "health",
    },
  ];
}
