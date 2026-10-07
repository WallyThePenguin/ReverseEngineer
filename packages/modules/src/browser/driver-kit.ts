// What the server's driver (apps/server/src/browser/driver, B1) shares with the browser module:
// the page-side helpers it installs in its isolated worlds, the test for what sends and when to
// ask (classify.ts), keys, pacing, how a read says the page is still loading, and the policy each
// step carries from the kernel to Chrome.
import { PAGE_RULES } from "./classify.ts";
import { pageFunction } from "./page.ts";

export {
  askWhy,
  dialogVerdict,
  type Floor,
  FREE,
  HEARTH_PAGE,
  isHearthPage,
  judge,
  REJECT,
  type Verdict,
} from "./classify.ts";
export { type Combo, isPaste, keyEvents, parseCombo, parseKeys, types } from "./keys.ts";
export { isLoopbackHost, paceFor } from "./pace.ts";
export { loadingRead, STILL_LOADING, snapshotExpression } from "./page.ts";
export { keyRefusal } from "./steps.ts";

const ELEMENTS = pageFunction("./page-elements.js", "pageElements");
const DRIVER = pageFunction("./page-driver.js", "pageDriver");

/** Installs the page-side helpers as `__hearth` in an isolated world, once. */
export const DRIVER_INSTALL = `globalThis.__hearth ??= (${DRIVER})((${ELEMENTS})(${JSON.stringify(PAGE_RULES)})); true`;

/**
 * What a step may do, decided in the kernel and checked again in Chrome as it happens: the
 * owner's own steps skip blocked sites and pacing; trusted sites let presses that send go ahead,
 * above the floor (D52).
 */
export interface DriverPolicy {
  owner: boolean;
  trusted: string[];
  blocked: string[];
  pace: { seconds: number; sites: Record<string, number> } | null;
  /** An approved step's site: it never runs on another the tab has moved to since. */
  site?: string;
}
