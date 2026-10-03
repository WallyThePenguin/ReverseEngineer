// Jarvis's hands in your Chrome (B2): click, type, pick from lists, press keys, and submit. Things
// are found by the references the page reader gave them ("E4"). Anything that would send
// something (a form's submit button, "Send", "Buy", Enter in most fields) is refused here and
// goes through browser.submit, which waits for your yes. Passwords are typed only by
// browser.sign_in, from the vault.
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import type { BrowserClient, TabInfo } from "./client.ts";
import { cdp, clickAt, insertText, KEYS, type KeyName, pressKey } from "./input.ts";
import { pace } from "./pace.ts";
import {
  elementSeen,
  evaluate,
  findTab,
  forgetLinks,
  pageCall,
  pageFunction,
  waitForLoad,
} from "./page.ts";

const ACT = pageFunction("./page-act.js", "pageAct");
const PROBE = pageFunction("./page-probe.js", "pageProbe");

export interface ElementState {
  missing: boolean;
  kind: string;
  label: string;
  submits: boolean;
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

const element = z
  .string()
  .regex(/^E\d+$/)
  .describe('Something on the page, by its reference from browser_read, e.g. "E3".');
const tabId = z.number().int();

/** Finds an element on the tab's page and gets it ready. */
export async function locate(
  ctx: ActionContext,
  i: { tabId: number; element: string },
  op: "inspect" | "focus" | "choose",
  extra: Record<string, unknown> = {},
  paced = true,
): Promise<{ client: BrowserClient; tab: TabInfo; el: ElementState }> {
  const client = browser(ctx);
  const tab = await findTab(client, i.tabId);
  const url = await assertAllowed(ctx, tab.url);
  if (paced) await pace(ctx, url);
  const el = await evaluate<ElementState>(
    client,
    i.tabId,
    pageCall(ACT, { ref: i.element, op, ...extra }),
  );
  if (!el || el.missing)
    throw new ActionError(
      "not_found",
      `${i.element} isn't on the page any more. Read the page again (browser_read) for fresh references.`,
    );
  return { client, tab, el };
}

function assertPressable(el: ElementState, ref: string): void {
  if (el.disabled) throw new ActionError("failed", `"${el.label || ref}" is disabled right now.`);
  if (el.covered)
    throw new ActionError(
      "failed",
      `Something covers ${ref}${el.coveredBy ? ` ("${el.coveredBy}")` : ""}. Close it, then read the page again.`,
    );
}

/** Waits for what a step set off, and steps back from a blocked site it led to. */
export async function afterStep(ctx: ActionContext, client: BrowserClient, before: TabInfo) {
  const after = await waitForLoad(client, before.tabId);
  const moved = after.url !== before.url;
  if (moved) {
    forgetLinks(before.tabId);
    try {
      await assertAllowed(ctx, after.url);
    } catch (err) {
      await cdp(client, before.tabId, "Page.navigate", { url: before.url }).catch(() => {});
      throw err;
    }
  }
  return { url: after.url, pageChanged: moved, next: "Read the page again to see what changed." };
}

const SITE_CHECK = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "A site name, like shop.example.");

/** A step approved for one site never runs on another the tab has moved to since. */
function assertSite(tab: TabInfo, site: string | undefined): void {
  if (!site) return;
  const host = new URL(tab.url).hostname;
  if (host !== site && !host.endsWith(`.${site}`))
    throw new ActionError(
      "conflict",
      `Tab ${tab.tabId} is on ${host} now, not ${site}. Nothing was done.`,
    );
}

/** "\"Email\" on shop.example", from what the page reader last saw. */
function described(i: { tabId: number; element: string; site?: string }): string {
  const seen = elementSeen(i.tabId, i.element);
  const where = i.site ?? (seen ? new URL(seen.url).hostname : `tab ${i.tabId}`);
  const what = seen?.element?.label ? `"${seen.element.label}"` : i.element;
  return `${what} on ${where}`;
}

const same = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

type Services = { service<T>(name: string): T };

/** The tab's address, for D30's check on acting after outside content. */
async function tabPin(i: { tabId: number }, services: Services) {
  const client = services.service<BrowserClient>("browser");
  const tabs = await client.call<TabInfo[]>("tabs.list");
  const url = tabs.find((t) => t.tabId === i.tabId)?.url;
  return url ? { url } : null;
}

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

export const actActions = [
  defineAction({
    name: "browser.click",
    description:
      "Click something on a page by its reference (a button, tab, menu, checkbox...). It won't press anything that sends, buys, posts or deletes; use browser_submit for that. Read the page again afterwards.",
    input: z.object({ tabId, element, site: SITE_CHECK.optional() }),
    risk: "internal",
    callers: CALLERS,
    // Results carry the page's own words (a button's name), so they're outside content.
    external: true,
    pin: tabPin,
    summarize: (i) => `Click ${described(i)}`,
    async handler(i, ctx) {
      const { client, tab, el } = await locate(ctx, i, "inspect");
      assertSite(tab, i.site);
      if (el.isLink)
        throw new ActionError(
          "invalid_input",
          `${i.element} is a link to a page; open it with browser_open and its [L] reference.`,
        );
      if (TYPEABLE.has(el.kind) || el.kind === "password field")
        throw new ActionError("invalid_input", `${i.element} is a ${el.kind}; use browser_type.`);
      if (el.submits)
        throw new ActionError(
          "forbidden",
          `Pressing "${el.label}" would send something. Use browser_submit, which asks the owner first.`,
        );
      assertPressable(el, i.element);
      await clickAt(client, i.tabId, i.element, el.x, el.y);
      return { tabId: i.tabId, pressed: el.label, ...(await afterStep(ctx, client, tab)) };
    },
  }),
  defineAction({
    name: "browser.type",
    description:
      "Type into a field or text area by its reference. Replaces what's there unless clear is false. Never presses Enter; use browser_submit to send a form. Passwords are typed only by browser_sign_in.",
    input: z.object({
      tabId,
      element,
      text: z.string().max(10_000),
      clear: z.boolean().default(true),
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    external: true,
    pin: tabPin,
    summarize: (i) => `Type into ${described(i)}: "${i.text.slice(0, 120)}"`,
    async handler(i, ctx) {
      const { client, tab, el } = await locate(ctx, i, "inspect");
      assertSite(tab, i.site);
      if (el.kind === "password field")
        throw new ActionError(
          "forbidden",
          "Passwords are typed only by browser_sign_in, from the owner's vault.",
        );
      if (!TYPEABLE.has(el.kind))
        throw new ActionError("invalid_input", `${i.element} is a ${el.kind}, not a field.`);
      if (el.disabled) throw new ActionError("failed", `"${el.label}" is disabled right now.`);
      const ready = await locate(ctx, i, "focus", { clear: i.clear }, false);
      if (!ready.el.focused)
        throw new ActionError("failed", `Couldn't put the cursor in "${el.label}".`);
      if (i.text) await insertText(client, i.tabId, i.text);
      return { tabId: i.tabId, typedInto: el.label, characters: i.text.length };
    },
  }),
  defineAction({
    name: "browser.choose",
    description:
      'Pick an option in a list (by its text), or set a checkbox to "on" or "off", by reference.',
    input: z.object({ tabId, element, value: z.string().max(300), site: SITE_CHECK.optional() }),
    risk: "internal",
    callers: CALLERS,
    external: true,
    pin: tabPin,
    summarize: (i) => `Set ${described(i)} to "${i.value}"`,
    async handler(i, ctx) {
      const peek = await locate(ctx, i, "inspect");
      assertSite(peek.tab, i.site);
      if (peek.el.submits)
        throw new ActionError(
          "forbidden",
          `Changing "${peek.el.label}" may take effect at once. Use browser_submit, which asks the owner first.`,
        );
      const { client, tab, el } = await locate(ctx, i, "choose", { value: i.value }, false);
      if (el.error) throw new ActionError("invalid_input", el.error);
      if (el.toggle) {
        assertPressable(el, i.element);
        await clickAt(client, i.tabId, i.element, el.x, el.y);
      }
      const now = await locate(ctx, i, "inspect", {}, false).catch(() => null);
      await afterStep(ctx, client, tab);
      return { tabId: i.tabId, element: el.label, now: now?.el.state ?? el.state };
    },
  }),
  defineAction({
    name: "browser.key",
    description:
      "Press a key in a tab: Escape to close a popup, Tab or the arrows to move around, Backspace to delete. Enter is browser_submit.",
    input: z.object({
      tabId,
      key: z.enum(Object.keys(KEYS).filter((k) => k !== "Enter") as [KeyName, ...KeyName[]]),
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    external: true,
    pin: tabPin,
    summarize: (i) => `Press ${i.key} in tab ${i.tabId}${i.site ? ` on ${i.site}` : ""}`,
    async handler(i, ctx) {
      const client = browser(ctx);
      const tab = await findTab(client, i.tabId);
      assertSite(tab, i.site);
      await pace(ctx, await assertAllowed(ctx, tab.url));
      if (MOVES.has(i.key)) {
        // An arrow on a list or radio group changes the choice, which can take effect at once.
        const active = await evaluate<{ kind: string | null; label?: string }>(
          client,
          i.tabId,
          pageCall(PROBE, { op: "active" }),
        );
        if (active?.kind && CHOICES.has(active.kind))
          throw new ActionError(
            "forbidden",
            `${i.key} would change "${active.label ?? active.kind}". Use browser_choose to pick an option.`,
          );
      }
      await pressKey(client, i.tabId, i.key);
      return { tabId: i.tabId, pressed: i.key, ...(await afterStep(ctx, client, tab)) };
    },
  }),
  defineAction({
    name: "browser.submit",
    description:
      "Press something that sends: a form's submit button, Send, Buy, Post, or Enter in a field. Give the name it showed in browser_read as label; it's checked against the page before pressing.",
    input: z.object({
      tabId,
      element,
      label: z
        .string()
        .max(200)
        .describe("Its name as browser_read showed it, e.g. 'Place order'."),
      site: SITE_CHECK.describe("The site the page is on, e.g. shop.example."),
      sends: SENDS.optional(),
    }),
    risk: "outward",
    callers: CALLERS,
    external: true,
    // Pinned to what the press would send, so the card can show it and the press is refused if
    // the page or the form changed by the time it's approved.
    async pin(i, services) {
      const client = services.service<BrowserClient>("browser");
      const sends = await probeForm(client, i.tabId, i.element);
      return sends ? { url: sends.url, extra: { sends } } : null;
    },
    summarize: (i) => {
      const fields = (i.sends?.fields ?? []).map((f) => `${f.label}: "${f.value.slice(0, 80)}"`);
      return `Press "${i.label}" on ${i.site}${fields.length ? `, sending ${fields.join(", ")}` : ""}`;
    },
    async handler(i, ctx) {
      const { client, tab, el } = await locate(ctx, i, "inspect");
      assertSite(tab, i.site);
      if (!same(el.label, i.label))
        throw new ActionError(
          "conflict",
          `The page changed: ${i.element} is now "${el.label}", not "${i.label}". Nothing was pressed.`,
        );
      if (i.sends) {
        const now = await probeForm(client, i.tabId, i.element);
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
        assertPressable(el, i.element);
        await clickAt(client, i.tabId, i.element, el.x, el.y);
      }
      return { tabId: i.tabId, pressed: el.label, ...(await afterStep(ctx, client, tab)) };
    },
  }),
];
