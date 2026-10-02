// Who may use your Chrome, and where: shared by the browser's actions and page watches.
import { normalizeUrl, onSiteList, type PrincipalKind } from "@hearth/core";
import { type ActionContext, ActionError, getSetting } from "@hearth/kernel";
import { BROWSER_SERVICE, type BrowserClient } from "./client.ts";

/** Your Chrome is yours: outside agents and integrations never get it. */
export const CALLERS: PrincipalKind[] = ["owner", "agent", "system"];

export function browser(ctx: ActionContext): BrowserClient {
  return ctx.service<BrowserClient>(BROWSER_SERVICE);
}

/**
 * Refuses blocked sites to anyone but you (or to you too, with `everyone`, for things that run
 * later without you). Returns the address to open, #fragment and all, since apps like Gmail
 * route by it.
 */
export async function assertAllowed(
  ctx: ActionContext,
  raw: string,
  everyone = false,
): Promise<string> {
  if (!normalizeUrl(raw))
    throw new ActionError("invalid_input", `${raw} isn't an http or https address.`);
  const url = new URL(raw.trim()).href;
  if (ctx.caller.kind === "owner" && !everyone) return url;
  const sites = await getSetting(ctx.tx, "browser.sites");
  const host = new URL(url).hostname;
  if (onSiteList(host, sites.blocked))
    throw new ActionError("forbidden", `${host} is on your list of sites Jarvis never opens.`);
  return url;
}
