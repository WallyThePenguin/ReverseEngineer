// Jarvis's hands in your Chrome (B2, D52): click, type, pick from lists and submit. Things are
// found by the refs browser_read_page gave them ("ref_12") or points in the last screenshot,
// which go to the server's driver (B1, drive-act.ts), or by the older references browser_read
// gave them ("E4"), which still work here. A press that would send something is free on a site
// you trust, unless it hits the floor (payments, passwords and security, moving money, deleting
// an account); otherwise it's refused and goes through browser.submit, which waits for your yes.
// Passwords are typed only by browser.sign_in, from the vault, and card details never.
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed, assertNotHearth, browser, CALLERS } from "./access.ts";
import { askWhy, HEARTH_MARK, HEARTH_PAGE, isTrusted, judge, type Verdict } from "./classify.ts";
import type { BrowserClient, TabInfo } from "./client.ts";
import { DRIVER_REF, point } from "./drive.ts";
import { driverClick, driverPress, driverProbe, driverType } from "./drive-act.ts";
import { clickAt, insertText, movedOn, pressKey, type RefPage } from "./input.ts";
import { pace } from "./pace.ts";
import { elementSeen, evaluate, pageCall, pageFunction, readDoc } from "./page.ts";
import {
  afterStep,
  assertHere,
  assertSite,
  beforeStep,
  handsPin,
  ref,
  SITE_CHECK,
  tabId,
} from "./step.ts";

export { afterStep } from "./step.ts";

/** A ref from either reader: browser_read_page's "ref_12", or browser_read's "E4". */
const anyRef = z
  .string()
  .regex(/^(ref_\d+|E\d+)$/)
  .describe(
    'Something on the page, by its ref from browser_read_page or browser_find ("ref_12"), or from browser_read ("E3").',
  );

/** Whether a step goes to the server's driver: anything but browser_read's "E4". */
const toDriver = (r: string | undefined) => r === undefined || DRIVER_REF.test(r);

/** A step where browser_read's references can't go: they need a ref_N from browser_read_page. */
function legacyOnly(what: string): never {
  throw new ActionError(
    "invalid_input",
    `${what} works with refs from browser_read_page ("ref_12"), not browser_read's. Read the page with browser_read_page.`,
  );
}

const ACT = pageFunction("./page-act.js", "pageAct");
const PROBE = pageFunction("./page-probe.js", "pageProbe");

export interface ElementState {
  missing: boolean;
  /** Where the page is as it answers: a step judges its site and trust by this. */
  href: string;
  hearth?: boolean;
  moved?: boolean;
  kind: string;
  label: string;
  submits: boolean;
  floor: Verdict["floor"];
  why: string;
  card: boolean;
  state: string;
  disabled: boolean;
  x: number;
  y: number;
  covered: boolean;
  coveredBy: string | null;
  isLink: boolean;
  focused: boolean;
  toggle: boolean;
  error: string | null;
}

const TYPEABLE = new Set(["field", "text area"]);

/**
 * Finds an element on the tab's page and gets it ready, on the page it was read from and, for
 * anyone but you, not Hearth's own: the page checks both before it's touched, so one that changes
 * while Jarvis waits its turn (or comes back from the cache) gets nothing. `tab.url` is where the
 * page said it was.
 */
export async function locate(
  ctx: ActionContext,
  i: { tabId: number; ref: string },
  op: "inspect" | "focus" | "choose",
  extra: Record<string, unknown> = {},
  paced = true,
): Promise<{
  client: BrowserClient;
  tab: TabInfo;
  known: Set<number>;
  el: ElementState;
  page: RefPage;
}> {
  const client = browser(ctx);
  const { tab, known } = await beforeStep(client, i.tabId);
  const doc = readDoc(i.tabId);
  const guarded = ctx.caller.kind !== "owner";
  if (guarded && doc === undefined) throw new ActionError("conflict", movedOn(i.tabId));
  const page: RefPage = {
    ...(doc === undefined ? {} : { doc }),
    ...(guarded ? { mark: HEARTH_MARK } : {}),
  };
  const url = await assertAllowed(ctx, tab.url);
  // Hearth's own page is refused before any wait, by its address or the mark in its head. A page
  // that goes elsewhere while Jarvis waits takes its references with it.
  if (paced) {
    assertNotHearth(ctx, url);
    await assertHere(ctx, client, i.tabId);
    await pace(ctx, url);
  }
  const el = await evaluate<ElementState>(
    client,
    i.tabId,
    pageCall(ACT, { ref: i.ref, op, ...extra, ...page }),
  );
  if (el?.hearth) throw new ActionError("forbidden", HEARTH_PAGE);
  if (el?.moved) throw new ActionError("conflict", movedOn(i.tabId));
  if (!el || el.missing)
    throw new ActionError(
      "not_found",
      `${i.ref} isn't on the page any more. Read the page again (browser_read) for fresh references.`,
    );
  return { client, tab: { ...tab, url: el.href || tab.url }, known, el, page };
}

function assertPressable(el: ElementState, ref: string): void {
  if (el.disabled) throw new ActionError("failed", `"${el.label || ref}" is disabled right now.`);
  if (el.covered)
    throw new ActionError(
      "failed",
      `Something covers ${ref}${el.coveredBy ? ` ("${el.coveredBy}")` : ""}. Close it, then read the page again.`,
    );
}

const verdictOf = (el: ElementState): Verdict => ({
  sends: el.submits,
  floor: el.floor ?? null,
  why: el.why ?? "",
});

/** Refuses a press that sends, unless the site is trusted and it's above the floor (D52). */
async function assertMayPress(
  ctx: ActionContext,
  tab: TabInfo,
  el: ElementState,
  what: string,
  instead = "Use browser_submit, which asks the owner first.",
) {
  const v = verdictOf(el);
  if (!v.sends) return;
  const trusted = await isTrusted(ctx, tab.url);
  if (judge(v, trusted) === "ask")
    throw new ActionError("forbidden", askWhy(what, v, trusted, instead));
}

/** "\"Email\" on shop.example", from what the page reader last saw. */
function described(i: {
  tabId: number;
  ref?: string | undefined;
  coordinate?: number[] | undefined;
  site?: string | undefined;
}): string {
  const on = i.site ? ` on ${i.site}` : "";
  if (!i.ref)
    return `${i.coordinate ? `[${i.coordinate.join(", ")}]` : "where the cursor is"} in tab ${i.tabId}${on}`;
  if (DRIVER_REF.test(i.ref)) return `${i.ref} in tab ${i.tabId}${on}`;
  const seen = elementSeen(i.tabId, i.ref);
  const where = i.site ?? (seen ? new URL(seen.url).hostname : `tab ${i.tabId}`);
  const what = seen?.element?.label ? `"${seen.element.label}"` : i.ref;
  return `${what} on ${where}`;
}

const same = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

const SENDS = z
  .object({
    url: z.string().max(2000),
    fields: z.array(z.object({ label: z.string().max(200), value: z.string().max(400) })).max(20),
  })
  .describe("Filled in by Hearth: what the press sends. Leave it out.");
type Sends = z.output<typeof SENDS>;

/** What pressing an element would send: the page and the fields of its form. */
const probeForm = (client: BrowserClient, tab: number, ref: string) =>
  evaluate<Sends>(client, tab, pageCall(PROBE, { op: "form", ref }));

const NO_CARDS = "Card and bank details are never Jarvis's to type; the owner types those.";

export const actActions = [
  defineAction({
    name: "browser.click",
    description:
      'Click something on a page (a button, link, tab, menu, checkbox...): by its ref from browser_read_page or browser_find, or at coordinate, a point [x, y] in the tab\'s last screenshot. button "right" opens a menu; clickCount 2 double-clicks; modifiers like "shift" or "ctrl+shift". On a site the owner trusts it presses anything but payments, passwords and security settings, money moves and account deletion; elsewhere it won\'t press what sends, posts or deletes (use browser_submit). It says what changed on the page; screenshot: true adds a picture.',
    input: z.object({
      tabId,
      ref: anyRef.optional(),
      coordinate: point.optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
      clickCount: z.number().int().min(1).max(3).default(1),
      modifiers: z.string().max(40).optional(),
      screenshot: z.boolean().default(false),
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    io: true,
    // Results carry the page's own words (a button's name), so they're outside content.
    external: true,
    pin: handsPin,
    summarize: (i) => `Click ${described(i)}`,
    async handler(i, ctx) {
      if (toDriver(i.ref)) return driverClick(ctx, i);
      if (i.coordinate || i.button !== "left" || i.clickCount > 1 || i.modifiers || i.screenshot)
        legacyOnly("Clicking with a coordinate, button, clickCount, modifiers or screenshot");
      const ref = i.ref as string;
      const { client, tab, known, el, page } = await locate(
        ctx,
        { tabId: i.tabId, ref },
        "inspect",
      );
      assertSite(tab, i.site);
      assertNotHearth(ctx, tab.url);
      if (el.isLink)
        throw new ActionError(
          "invalid_input",
          `${ref} is a link to a page; open it with browser_open and its [L] reference.`,
        );
      if (TYPEABLE.has(el.kind) || el.kind === "password field")
        throw new ActionError("invalid_input", `${ref} is a ${el.kind}; use browser_type.`);
      await assertMayPress(ctx, tab, el, `Pressing "${el.label}"`);
      assertPressable(el, ref);
      await clickAt(client, i.tabId, ref, el.x, el.y, page);
      return { tabId: i.tabId, pressed: el.label, ...(await afterStep(ctx, client, tab, known)) };
    },
  }),
  defineAction({
    name: "browser.type",
    description:
      "Type into a field or text area as real keystrokes: by its ref, or without one into whatever has the keyboard's focus (after a click, say). With a ref it replaces what's there unless clear is false. Never presses Enter (browser_key or browser_submit does). Passwords are typed only by browser_sign_in, and card details never.",
    input: z.object({
      tabId,
      ref: anyRef.optional(),
      text: z.string().max(10_000),
      clear: z.boolean().default(true),
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    io: true,
    external: true,
    pin: handsPin,
    summarize: (i) => `Type into ${described(i)}: "${i.text.slice(0, 120)}"`,
    async handler(i, ctx) {
      if (toDriver(i.ref)) return driverType(ctx, i);
      const { client, tab, el } = await locate(
        ctx,
        { tabId: i.tabId, ref: i.ref as string },
        "inspect",
      );
      assertSite(tab, i.site);
      assertNotHearth(ctx, tab.url);
      if (el.kind === "password field")
        throw new ActionError(
          "forbidden",
          "Passwords are typed only by browser_sign_in, from the owner's vault.",
        );
      if (el.card) throw new ActionError("forbidden", NO_CARDS);
      if (!TYPEABLE.has(el.kind))
        throw new ActionError("invalid_input", `${i.ref} is a ${el.kind}, not a field.`);
      if (el.disabled) throw new ActionError("failed", `"${el.label}" is disabled right now.`);
      const ready = await locate(
        ctx,
        { tabId: i.tabId, ref: i.ref as string },
        "focus",
        { clear: i.clear },
        false,
      );
      // Still the page it read (focusing checks), so one sent to Hearth's own gets nothing.
      if (!ready.el.focused)
        throw new ActionError("failed", `Couldn't put the cursor in "${el.label}".`);
      if (i.text) await insertText(client, i.tabId, i.text);
      return { tabId: i.tabId, typedInto: el.label, characters: i.text.length };
    },
  }),
  defineAction({
    name: "browser.choose",
    description:
      'Pick an option in a list (by its text), or set a checkbox to "on" or "off", by a reference from browser_read ("E3"). With refs from browser_read_page, use browser_form_input.',
    input: z.object({ tabId, ref, value: z.string().max(300), site: SITE_CHECK.optional() }),
    risk: "internal",
    callers: CALLERS,
    io: true,
    external: true,
    pin: handsPin,
    summarize: (i) => `Set ${described(i)} to "${i.value}"`,
    async handler(i, ctx) {
      const peek = await locate(ctx, i, "inspect");
      assertSite(peek.tab, i.site);
      assertNotHearth(ctx, peek.tab.url);
      await assertMayPress(ctx, peek.tab, peek.el, `Changing "${peek.el.label}"`);
      const { client, tab, el, page } = await locate(ctx, i, "choose", { value: i.value }, false);
      if (el.error) throw new ActionError("invalid_input", el.error);
      if (el.toggle) {
        assertPressable(el, i.ref);
        await clickAt(client, i.tabId, i.ref, el.x, el.y, page);
      }
      const now = await locate(ctx, i, "inspect", {}, false).catch(() => null);
      const step = await afterStep(ctx, client, tab, peek.known);
      return { tabId: i.tabId, element: el.label, now: now?.el.state ?? el.state, ...step };
    },
  }),
  defineAction({
    name: "browser.submit",
    description:
      "Press something that sends, with the owner's yes: a form's submit button, Send, Buy, Post, or Enter in a field. Give its ref and the name it showed in browser_read_page as label; both are checked against the page before pressing.",
    input: z.object({
      tabId,
      ref: anyRef,
      label: z
        .string()
        .max(200)
        .describe("Its name as browser_read_page showed it, e.g. 'Place order'."),
      site: SITE_CHECK.describe("The site the page is on, e.g. shop.example."),
      sends: SENDS.optional(),
    }),
    risk: "outward",
    callers: CALLERS,
    io: true,
    external: true,
    // Pinned to what the press would send, so the card can show it and the press is refused if
    // the page or the form changed by the time it's approved.
    async pin(i, services) {
      const client = services.service<BrowserClient>("browser");
      if (DRIVER_REF.test(i.ref)) {
        // The tab's address, even for a form in a frame from another site: the approved press
        // then runs only while the tab is still on that site.
        const [tab, sends] = await Promise.all([
          handsPin(i, services),
          driverProbe(client, i.tabId, i.ref),
        ]);
        if (tab?.refused) return tab;
        return tab && sends ? { url: tab.url, extra: { sends } } : null;
      }
      // Hearth's own page: what a card would press there can't be told from another approval's.
      const tab = await handsPin(i, services);
      if (tab?.refused) return tab;
      const sends = await probeForm(client, i.tabId, i.ref);
      return sends ? { url: sends.url, extra: { sends } } : null;
    },
    summarize: (i) => {
      const fields = (i.sends?.fields ?? []).map((f) => `${f.label}: "${f.value.slice(0, 80)}"`);
      return `Press "${i.label}" on ${i.site}${fields.length ? `, sending ${fields.join(", ")}` : ""}`;
    },
    async handler(i, ctx) {
      if (DRIVER_REF.test(i.ref)) return driverPress(ctx, i);
      const { client, tab, known, el, page } = await locate(ctx, i, "inspect");
      assertSite(tab, i.site);
      assertNotHearth(ctx, tab.url);
      if (!same(el.label, i.label))
        throw new ActionError(
          "conflict",
          `The page changed: ${i.ref} is now "${el.label}", not "${i.label}". Nothing was pressed.`,
        );
      if (i.sends) {
        const now = await probeForm(client, i.tabId, i.ref);
        if (JSON.stringify(now) !== JSON.stringify(i.sends))
          throw new ActionError(
            "conflict",
            "The page or what it would send changed since this was asked. Nothing was pressed.",
          );
      }
      if (TYPEABLE.has(el.kind) || el.kind === "password field") {
        const ready = await locate(ctx, i, "focus", {}, false);
        if (!ready.el.focused) throw new ActionError("failed", `Couldn't focus "${el.label}".`);
        await pressKey(client, i.tabId, "Enter");
      } else {
        assertPressable(el, i.ref);
        await clickAt(client, i.tabId, i.ref, el.x, el.y, page);
      }
      return { tabId: i.tabId, pressed: el.label, ...(await afterStep(ctx, client, tab, known)) };
    },
  }),
];
