// Chrome's link as a health component, `browser` (D52): reported when it changes (after a moment,
// so Chrome restarting doesn't flap it) and every five minutes, so it never goes stale.
import { type Kernel, systemCaller } from "@hearth/kernel";
import { browserHealth } from "@hearth/modules";
import type { BrowserBridge } from "./bridge.ts";

export interface HealthTiming {
  everyMs: number;
  settleMs: number;
}

export function watchBrowserHealth(
  kernel: Kernel,
  bridge: BrowserBridge,
  timing: HealthTiming = { everyMs: 5 * 60_000, settleMs: 3_000 },
): () => void {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const report = async (force: boolean) => {
    if (stopped) return;
    const health = browserHealth(bridge.snapshot());
    const key = `${health.status}|${health.detail}`;
    if (!force && key === last) return;
    last = key;
    await kernel
      .execute("system.report", { component: "browser", ...health }, systemCaller())
      .catch(() => {});
  };
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void report(false), timing.settleMs);
  };
  const off = bridge.onState(soon);
  const every = setInterval(() => void report(true), timing.everyMs);
  soon();
  return () => {
    stopped = true;
    off();
    clearInterval(every);
    if (timer) clearTimeout(timer);
  };
}
