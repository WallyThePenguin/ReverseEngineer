// Pacing (B2): Jarvis waits a moment between steps on the same site, the way a person would, so
// sites don't take it for a bot. You set the wait, per site if you like; your own steps never wait,
// and neither do Hearth's own pages on this PC (its Chrome self-test).
import { onSiteList } from "@hearth/core";
import { type ActionContext, getSetting } from "@hearth/kernel";

/** Tests turn pacing off. */
export const pacing = { enabled: true };

// Per process, which is fine: Jarvis's steps all run in the Jarvis process.
const lastStep = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The wait for a host: its own entry if it has one (subdomains included), or the default. */
export function paceFor(
  host: string,
  pace: { seconds: number; sites: Record<string, number> },
): number {
  const own = Object.entries(pace.sites)
    .filter(([site]) => onSiteList(host, [site]))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return own ? own[1] : pace.seconds;
}

/** This PC: localhost, 127.x or ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h)
  );
}

/** Waits until this site's pause since Jarvis's last step there has passed. */
export async function pace(ctx: ActionContext, url: string): Promise<void> {
  if (!pacing.enabled || ctx.caller.kind === "owner") return;
  const host = new URL(url).hostname;
  if (isLoopbackHost(host)) return;
  const seconds = paceFor(host, await getSetting(ctx.tx, "browser.pace"));
  const wait = (lastStep.get(host) ?? 0) + seconds * 1000 - Date.now();
  if (wait > 0) await sleep(Math.min(wait, 60_000));
  lastStep.set(host, Date.now());
  if (lastStep.size > 500) lastStep.delete(lastStep.keys().next().value!);
}
