// Jarvis's hands through the server's driver (B1, D52): point, drag, scroll, fill in forms and run
// several steps at once, by refs from browser_read_page or points in the last screenshot. Every
// press is judged where it lands, in the driver: what doesn't send is free, what does is free on
// a site the owner trusts above the floor, and anything else is refused with `would_send`, for
// browser_submit to ask the owner. Each step says what it did and what changed on the page.
import { type ActionContext, ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { CALLERS } from "./access.ts";
import type { BrowserClient } from "./client.ts";
import { drive, driverRef, point, withImage } from "./drive.ts";
import { SITE_CHECK, tabId, tabPin } from "./step.ts";

const SHOT = z
  .boolean()
  .default(false)
  .describe("Also return a screenshot of the page after the step.");

type Result = Record<string, unknown>;

async function step(ctx: ActionContext, op: string, i: { tabId: number } & Result) {
  return withImage(await drive<Result>(ctx, op, i));
}

/** A ref or a point, not both. */
function oneOf(i: { ref?: string | undefined; coordinate?: unknown }, what: string): void {
  if (!i.ref === !i.coordinate)
    throw new ActionError("invalid_input", `Give either a ref or a coordinate to ${what}.`);
}

const at = (i: { tabId: number; ref?: string | undefined; coordinate?: number[] | undefined }) =>
  `${i.ref ?? `[${(i.coordinate ?? []).join(", ")}]`} in tab ${i.tabId}`;

export type DriverClick = {
  tabId: number;
  ref?: string | undefined;
  coordinate?: [number, number] | undefined;
  button: "left" | "right" | "middle";
  clickCount: number;
  modifiers?: string | undefined;
  screenshot: boolean;
  site?: string | undefined;
};

/** browser.click by a ref from browser_read_page, or at a point in the last screenshot. */
export function driverClick(ctx: ActionContext, i: DriverClick) {
  oneOf(i, "click");
  return step(ctx, "click", i);
}

/** browser.type by a ref from browser_read_page, or into whatever has the keyboard's focus. */
export function driverType(
  ctx: ActionContext,
  i: { tabId: number; ref?: string | undefined; text: string; clear: boolean; site?: string },
) {
  const { clear, ...rest } = i;
  // Without a ref, it types where the cursor is, adding to what's there.
  return step(ctx, "type", i.ref ? { ...rest, clear } : rest);
}

export interface Sends {
  url: string;
  fields: { label: string; value: string }[];
}

/** What pressing a ref would send: the page and the fields of its form (browser_submit's card). */
export const driverProbe = (client: BrowserClient, tab: number, ref: string) =>
  client.call<Sends>("driver.probe", { tabId: tab, ref });

/** browser.submit's press, with the owner's yes: checked by name and what it sends first. */
export function driverPress(
  ctx: ActionContext,
  i: { tabId: number; ref: string; label: string; sends?: Sends | undefined; site?: string },
) {
  return step(ctx, "press", i);
}

const BATCH_STEPS = [
  "click",
  "hover",
  "drag",
  "scroll",
  "scroll_to",
  "type",
  "key",
  "form_input",
  "wait",
] as const;

export const driveActActions = [
  defineAction({
    name: "browser.hover",
    description:
      "Point at something without clicking, to open a menu or show a tooltip: by ref, or at a point [x, y] in the last screenshot.",
    input: z.object({
      tabId,
      ref: driverRef.optional(),
      coordinate: point.optional(),
      screenshot: SHOT,
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    external: true,
    pin: tabPin,
    summarize: (i) => `Point at ${at(i)}`,
    handler(i, ctx) {
      oneOf(i, "point at");
      return step(ctx, "hover", i);
    },
  }),
  defineAction({
    name: "browser.drag",
    description:
      "Drag from one place to another (a slider, a map, a card on a board): fromRef or from [x, y], to toRef or to [x, y], points in the last screenshot. Where it starts and ends are judged like clicks.",
    input: z.object({
      tabId,
      fromRef: driverRef.optional(),
      from: point.optional(),
      toRef: driverRef.optional(),
      to: point.optional(),
      screenshot: SHOT,
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    external: true,
    pin: tabPin,
    summarize: (i) =>
      `Drag from ${i.fromRef ?? `[${(i.from ?? []).join(", ")}]`} to ${i.toRef ?? `[${(i.to ?? []).join(", ")}]`} in tab ${i.tabId}`,
    handler(i, ctx) {
      if (!i.fromRef === !i.from || !i.toRef === !i.to)
        throw new ActionError(
          "invalid_input",
          "Give where the drag starts (fromRef or from) and where it ends (toRef or to).",
        );
      return step(ctx, "drag", i);
    },
  }),
  defineAction({
    name: "browser.scroll",
    description:
      "Scroll a tab with the mouse wheel: up, down, left or right, by amount wheel steps (about 100 pixels each). Give coordinate, a point [x, y] in the last screenshot, to scroll a part of the page (a list, a map); otherwise it scrolls the middle of the page. Says where the page is now and whether it moved.",
    input: z.object({
      tabId,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(30).default(3),
      coordinate: point.optional(),
      screenshot: SHOT,
    }),
    risk: "read",
    callers: CALLERS,
    external: true,
    handler: (i, ctx) => step(ctx, "scroll", i),
  }),
  defineAction({
    name: "browser.scroll_to",
    description: "Scroll until something is in view, by its ref.",
    input: z.object({ tabId, ref: driverRef, screenshot: SHOT }),
    risk: "read",
    callers: CALLERS,
    external: true,
    handler: (i, ctx) => step(ctx, "scroll_to", i),
  }),
  defineAction({
    name: "browser.form_input",
    description:
      'Set a form control by its ref: an option in a list (by its text), a checkbox or switch ("on" or "off"), a radio button ("on"), a date ("2026-10-04"), a slider (a number), or the text of a field. Changing a switch that saves at once follows the same rules as browser_click. Passwords and card details never.',
    input: z.object({
      tabId,
      ref: driverRef,
      value: z.string().max(2000),
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    external: true,
    pin: tabPin,
    summarize: (i) => `Set ${i.ref} in tab ${i.tabId} to "${i.value.slice(0, 120)}"`,
    handler: (i, ctx) => step(ctx, "form_input", i),
  }),
  defineAction({
    name: "browser.batch",
    description:
      "Several steps in one tab, one after another, in one call: faster when you know what comes next (fill in three fields, then click). Each step is judged as it runs, as on its own, and the batch stops at the first one that fails (`stopped` says which and why). Each step is {action, input}, its input as for its own tool without tabId: click {ref | coordinate, button?, clickCount?, modifiers?}, type {text, ref?, clear?}, key {keys, repeat?}, form_input {ref, value}, scroll {direction, amount?, coordinate?}, scroll_to {ref}, hover {ref | coordinate}, drag {fromRef | from, toRef | to}, wait {ms}. If a step loads a new page, the steps after it that use refs are not run.",
    input: z.object({
      tabId,
      steps: z
        .array(
          z.object({
            action: z.enum(BATCH_STEPS),
            input: z.record(z.string(), z.unknown()).default({}),
          }),
        )
        .min(1)
        .max(25),
      screenshot: SHOT,
      site: SITE_CHECK.optional(),
    }),
    risk: "internal",
    callers: CALLERS,
    external: true,
    pin: tabPin,
    summarize: (i) =>
      `${i.steps.length} steps in tab ${i.tabId}: ${i.steps
        .map((s) => {
          const text = typeof s.input.text === "string" ? ` "${s.input.text.slice(0, 60)}"` : "";
          const ref = typeof s.input.ref === "string" ? ` ${s.input.ref}` : "";
          return `${s.action}${ref}${text}`;
        })
        .join(", ")}`,
    handler: (i, ctx) => step(ctx, "batch", i),
  }),
];
