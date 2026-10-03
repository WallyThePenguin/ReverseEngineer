// Jarvis's hands in your Chrome (B2): click, type, pick from lists, press keys, and submit. Things
// are found by the references the page reader gave them ("E4"). Anything that would send
// something (a form's submit button, "Send", "Buy", Enter in most fields) is refused here and
// goes through browser.submit, which waits for your yes. Passwords are typed only by
// browser.sign_in, from the vault.
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { assertAllowed, browser, CALLERS } from "./access.ts";
import type { BrowserClient, TabInfo } from "./client.ts";
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

const cdp = (client: BrowserClient, tab: number, method: string, params: object) =>
  client.call("cdp", { tabId: tab, method, params });

/** A left click at a point, as a person's mouse would make it. */
export async function clickAt(client: BrowserClient, tab: number, x: number, y: number) {
  const at = { x, y, button: "left", clickCount: 1 };
  await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mousePressed", ...at });
  await cdp(client, tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
} as const;
type KeyName = keyof typeof KEYS;

export async function pressKey(client: BrowserClient, tab: number, key: KeyName) {
  const k: { code: string; keyCode: number; text?: string } = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode };
  await cdp(client, tab, "Input.dispatchKeyEvent", {
    type: k.text ? "keyDown" : "rawKeyDown",
    ...base,
    ...(k.text ? { text: k.text } : {}),
  });
  await cdp(client, tab, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Types text into whatever has focus, as one paste-like input. */
export const insertText = (client: BrowserClient, tab: number, text: string) =>
  cdp(client, tab, "Input.insertText", { text });

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

const same = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** The tab's address, for D30's check on typing. */
async function tabUrl(
  i: { tabId: number },
  services: { service<T>(name: string): T },
): Promise<string | null> {
  const client = services.service<BrowserClient>("browser");
  const tabs = await client.call<TabInfo[]>("tabs.list");
  return tabs.find((t) => t.tabId === i.tabId)?.url ?? null;
}

export const actActions = [
  defineAction({
    name: "browser.click",
    description:
      "Click something on a page by its reference (a button, tab, menu, checkbox...). It won't press anything that sends, buys, posts or deletes; use browser_submit for that. Read the page again afterwards.",
    input: z.object({ tabId, element }),
    risk: "internal",
    callers: CALLERS,
    async handler(i, ctx) {
      const { client, tab, el } = await locate(ctx, i, "inspect");
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
      await clickAt(client, i.tabId, el.x, el.y);
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
    }),
    risk: "internal",
    callers: CALLERS,
    typesInto: tabUrl,
    summarize: (i) => {
      const seen = elementSeen(i.tabId, i.element);
      const where = seen ? new URL(seen.url).hostname : `tab ${i.tabId}`;
      const field = seen?.element?.label ? `"${seen.element.label}"` : i.element;
      return `Type into ${field} on ${where}: "${i.text.slice(0, 120)}"`;
    },
    async handler(i, ctx) {
      const { client, el } = await locate(ctx, i, "inspect");
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
    input: z.object({ tabId, element, value: z.string().max(300) }),
    risk: "internal",
    callers: CALLERS,
    async handler(i, ctx) {
      const { client, tab, el } = await locate(ctx, i, "choose", { value: i.value });
      if (el.error) throw new ActionError("invalid_input", el.error);
      if (el.toggle) {
        assertPressable(el, i.element);
        await clickAt(client, i.tabId, el.x, el.y);
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
    }),
    risk: "internal",
    callers: CALLERS,
    async handler(i, ctx) {
      const client = browser(ctx);
      const tab = await findTab(client, i.tabId);
      await pace(ctx, await assertAllowed(ctx, tab.url));
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
    }),
    risk: "outward",
    callers: CALLERS,
    summarize: (i) => {
      const seen = elementSeen(i.tabId, i.element);
      return `Press "${i.label}" on ${seen ? new URL(seen.url).hostname : `tab ${i.tabId}`}`;
    },
    async handler(i, ctx) {
      const { client, tab, el } = await locate(ctx, i, "inspect");
      if (!same(el.label, i.label))
        throw new ActionError(
          "conflict",
          `The page changed: ${i.element} is now "${el.label}", not "${i.label}". Nothing was pressed.`,
        );
      if (TYPEABLE.has(el.kind) || el.kind === "password field") {
        const ready = await locate(ctx, i, "focus", {}, false);
        if (!ready.el.focused) throw new ActionError("failed", `Couldn't focus "${el.label}".`);
        await pressKey(client, i.tabId, "Enter");
      } else {
        assertPressable(el, i.element);
        await clickAt(client, i.tabId, el.x, el.y);
      }
      return { tabId: i.tabId, pressed: el.label, ...(await afterStep(ctx, client, tab)) };
    },
  }),
];
