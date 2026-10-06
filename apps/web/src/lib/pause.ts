// Pausing Jarvis's initiative, from Settings or the command palette. Kept apart from Settings so
// the palette doesn't pull the whole Settings screen into the first download.

import { toast } from "./live.ts";
import { act } from "./query.ts";

export async function setPaused(paused: boolean) {
  if (await act(paused ? "jarvis.pause" : "jarvis.resume")) {
    toast.show(
      paused
        ? "Jarvis is paused. It still answers you, and alerts still come through."
        : "Jarvis is back on.",
    );
  }
}
