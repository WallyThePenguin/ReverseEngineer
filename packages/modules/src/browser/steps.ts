// More of Jarvis's hands (D52): keys and key combinations, answering a page's dialogs, and saying
// no to cookie banners. Keys follow the same test as clicks: Enter that would send a form or a
// message, Space on a button that sends, are free only on a site you trust and above the floor.
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed, assertNotHearth, browser, CALLERS } from "./access.ts";
import { askWhy, dialogVerdict, isTrusted, judge, REJECT, type Verdict } from "./classify.ts";
import type { BrowserClient } from "./client.ts";
import { clickAt, pressCombo } from "./input.ts";
import { type Combo, isPaste, parseKeys, types } from "./keys.ts";
import { pace } from "./pace.ts";
import { evaluate, pageCall, pageFunction } from "./page.ts";
import { afterStep, assertSite, beforeStep, handsPin, SITE_CHECK, tabId, tabPin } from "./step.ts";

const PROBE = pageFunction("./page-probe.js", "pageProbe");

/** What has the keyboard's focus, and what Enter or a click would do there. */
interface Active {
  kind: string | null;
  label?: string;
  editable: boolean;
  password?: boolean;
  card?: boolean;
  enter?: Verdict;
  click?: Verdict;
}

/** Keys that move a choice in a list, radio group or checkbox, rather than just the cursor. */
const MOVES = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);
const CHOICES = new Set(["select", "radio", "checkbox", "option"]);

/** Whether a press needs a look at what has focus first. */
const sensitive = (c: Combo) =>
  c.key.key === "Enter" ||
  c.key.key === " " ||
  c.key.key === "Delete" ||
  types(c) ||
  MOVES.has(c.key.key);

/** Why a press is refused, or null if it may go ahead. */
export function keyRefusal(c: Combo, a: Active, trusted: boolean): string | null {
  const where = a.label ? ` in "${a.label}"` : "";
  if (types(c) && a.password)
    return "Passwords are typed only by browser_sign_in, from the owner's vault.";
  if (types(c) && a.card)
    return "Card and bank details are never Jarvis's to type; the owner types those.";
  let v: Verdict | undefined;
  if (c.key.key === "Enter") {
    // Shift+Enter in a text box is a new line.
    if (a.kind === "text area" && c.shift && !c.ctrl && !c.meta && !c.alt) return null;
    v = a.editable ? a.enter : a.click;
  } else if (c.key.key === " " && !a.editable) v = a.click;
  else if (MOVES.has(c.key.key) && a.kind && CHOICES.has(a.kind))
    return `${c.name} would change "${a.label || a.kind}". Use browser_choose to pick an option.`;
  else if ((types(c) || c.key.key === "Delete") && !a.editable && !trusted)
    return `"${c.name}" outside a text box may be one of the site's keyboard shortcuts, which can send or delete things. Click what you mean, or type into a field. On a site the owner trusts, this is allowed.`;
  if (!v || judge(v, trusted) === "go") return null;
  return askWhy(
    `Pressing ${c.name}${where}`,
    v,
    trusted,
    "Use browser_submit, which asks the owner first.",
  );
}

/** "ctrl+a Backspace Backspace Backspace" as "ctrl+a, Backspace ×3". */
function tally(names: string[]): string {
  const out: [string, number][] = [];
  for (const n of names) {
    const last = out[out.length - 1];
    if (last && last[0] === n) last[1]++;
    else out.push([n, 1]);
  }
  return out.map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(", ");
}

/** The page a tab is on right now, asked of the page itself. */
const where = (client: BrowserClient, tab: number) =>
  evaluate<string>(client, tab, "location.href").catch(() => "");

async function ready(ctx: ActionContext, i: { tabId: number; site?: string }) {
  const client = browser(ctx);
  const { tab, known } = await beforeStep(client, i.tabId);
  assertSite(tab, i.site);
  const url = await assertAllowed(ctx, tab.url);
  assertNotHearth(ctx, url);
  await pace(ctx, url);
  return { client, tab, known };
}

export const stepActions = [
  defineAction({
    name: "browser.key",
    description:
      'Press keys in a tab, as on a keyboard: "Escape", "Tab", "shift+Tab", "ctrl+a Backspace", "ArrowDown", "Enter". Presses are separated by spaces, combinations joined with +, and repeat presses them all again. Enter and Space follow the same rules as browser_click (on a site the owner trusts, Enter may send). Pasting is never allowed.',
    input: z.object({
      tabId,
      keys: z.string().trim().min(1).max(300),
      repeat: z.number().int().min(1).max(100).default(1),
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    io: true,
    external: true,
    pin: handsPin,
    summarize: (i) =>
      `Press ${i.keys}${i.repeat > 1 ? ` ${i.repeat} times` : ""} in tab ${i.tabId}${i.site ? ` on ${i.site}` : ""}`,
    async handler(i, ctx) {
      const combos = parseKeys(i.keys);
      if (combos.length * i.repeat > 200)
        throw new ActionError("invalid_input", "That's too many presses at once (200 at most).");
      if (combos.some(isPaste))
        throw new ActionError(
          "forbidden",
          "Pasting isn't allowed: it would send whatever is on the owner's clipboard. Type the text with browser_type.",
        );
      const { client, tab, known } = await ready(ctx, i);
      const trusted = await isTrusted(ctx, tab.url);
      const done: string[] = [];
      let dialog = false;
      const began = await where(client, i.tabId);
      for (let r = 0; r < i.repeat && !dialog; r++) {
        for (const c of combos) {
          // A page that sends itself somewhere (Hearth's own page) mid-step stops it there.
          if (ctx.caller.kind !== "owner" && (await where(client, i.tabId)) !== began)
            throw new ActionError(
              "conflict",
              `The tab went to another page partway through, so Jarvis stopped there.${done.length ? ` (Already pressed: ${tally(done)}.)` : ""}`,
            );
          if (sensitive(c)) {
            const active = await evaluate<Active>(
              client,
              i.tabId,
              pageCall(PROBE, { op: "active" }),
            );
            const no = active ? keyRefusal(c, active, trusted) : null;
            if (no)
              throw new ActionError(
                "forbidden",
                done.length ? `${no} (Already pressed: ${tally(done)}.)` : no,
              );
          }
          dialog = await pressCombo(client, i.tabId, c);
          done.push(c.name);
          if (dialog) break;
        }
      }
      return {
        tabId: i.tabId,
        pressed: tally(done),
        ...(await afterStep(ctx, client, tab, known)),
      };
    },
  }),
  defineAction({
    name: "browser.dialog",
    description:
      'Answer the alert, confirm, prompt or "leave site?" dialog open in a tab (browser_tabs shows what it says): accept (OK, Leave) or not (Cancel, Stay), with promptText for a prompt. Accepting a confirm that sends something follows the same rules as browser_click.',
    input: z.object({
      tabId,
      accept: z.boolean(),
      promptText: z.string().max(2000).optional(),
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    io: true,
    external: true,
    pin: (i, s) => (i.accept ? handsPin(i, s) : tabPin(i, s)),
    summarize: (i) => `${i.accept ? "Accept" : "Dismiss"} the dialog in tab ${i.tabId}`,
    async handler(i, ctx) {
      const client = browser(ctx);
      const { tab, known } = await beforeStep(client, i.tabId);
      assertSite(tab, i.site);
      await assertAllowed(ctx, tab.url);
      // Cancel or Stay is fine on Hearth's own page; OK or Leave there is the owner's.
      if (i.accept) assertNotHearth(ctx, tab.url);
      const dialog = tab.dialog;
      if (!dialog) throw new ActionError("not_found", `There's no dialog open in tab ${i.tabId}.`);
      if (i.accept) {
        const v = dialogVerdict(dialog);
        const trusted = await isTrusted(ctx, tab.url);
        if (judge(v, trusted) === "ask")
          throw new ActionError(
            "forbidden",
            askWhy(
              "Accepting this dialog",
              v,
              trusted,
              "Dismiss it (accept: false), or ask the owner to answer it in Chrome.",
            ),
          );
      }
      const prompt = dialog.type === "prompt" && i.promptText !== undefined;
      await client.call("cdp", {
        tabId: i.tabId,
        method: "Page.handleJavaScriptDialog",
        params: { accept: i.accept, ...(prompt ? { promptText: i.promptText } : {}) },
      });
      return {
        tabId: i.tabId,
        answered: dialog.type,
        accepted: i.accept,
        ...(await afterStep(ctx, client, tab, known)),
      };
    },
  }),
  defineAction({
    name: "browser.reject_cookies",
    description:
      'Close a cookie banner the private way: presses its "Reject all" or "Necessary only" button. If it has none, read the page and pick one with browser_click (a banner\'s buttons never count as sending).',
    input: z.object({ tabId, site: SITE_CHECK.optional() }),
    risk: "internal",
    callers: CALLERS,
    io: true,
    external: true,
    pin: handsPin,
    summarize: (i) => `Reject cookies in tab ${i.tabId}`,
    async handler(i, ctx) {
      const { client, tab, known } = await ready(ctx, i);
      const found = await evaluate<{
        found: boolean;
        banner: boolean;
        buttons?: string[];
        label?: string;
        floor?: Verdict["floor"];
        x?: number;
        y?: number;
        covered?: boolean;
      }>(client, i.tabId, pageCall(PROBE, { op: "consent", reject: REJECT.source }));
      if (!found?.banner)
        throw new ActionError(
          "not_found",
          "There's no cookie banner Hearth can see on this page. (One inside another site's frame can't be reached; read the page or take a screenshot.)",
        );
      if (!found.found)
        throw new ActionError(
          "not_found",
          `The cookie banner has no reject button. Its buttons say: ${(found.buttons ?? []).join("; ")}. Read the page and pick one with browser_click.`,
        );
      if (found.floor)
        throw new ActionError(
          "forbidden",
          askWhy(
            `Pressing "${found.label}"`,
            { sends: true, floor: found.floor, why: "" },
            false,
            "That's no cookie banner; leave it to the owner.",
          ),
        );
      if (found.covered || found.x === undefined || found.y === undefined)
        throw new ActionError("failed", "Something covers the banner's reject button.");
      await clickAt(client, i.tabId, "C1", found.x, found.y);
      return {
        tabId: i.tabId,
        pressed: found.label,
        ...(await afterStep(ctx, client, tab, known)),
      };
    },
  }),
];
