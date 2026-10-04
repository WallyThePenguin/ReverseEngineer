// How Chrome's link to Hearth is doing, as a health component (D52): the server reports it as
// `browser`, and the doctor can call the same check.
import type { BrowserStatus } from "./client.ts";

export interface BrowserHealth {
  status: "ok" | "degraded" | "failing";
  detail: string;
}

export function browserHealth(s: BrowserStatus): BrowserHealth {
  if (s.paired === false)
    return {
      status: "degraded",
      detail:
        "No Chrome extension is paired, so Jarvis can't use Chrome. Pair it in Settings, Chrome.",
    };
  if (s.connected) {
    if (s.problem) return { status: "degraded", detail: s.problem };
    return { status: "ok", detail: `Connected (extension ${s.version ?? "?"}).` };
  }
  if (s.openError)
    return { status: "failing", detail: `Hearth couldn't open Chrome: ${s.openError}` };
  if (s.opening) return { status: "ok", detail: "Opening Chrome." };
  if (s.canOpen)
    return { status: "ok", detail: "Chrome is closed; Hearth opens it when Jarvis needs it." };
  return {
    status: "degraded",
    detail:
      "Chrome isn't connected. Open Chrome on the PC; the Hearth extension connects by itself.",
  };
}
