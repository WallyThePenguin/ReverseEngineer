// The mouse (B1, D52): click, hover, drag, scroll and scroll to, by ref or by a point in the last
// screenshot. Every press is judged where it lands (classifier v2): a ref's own element, checked
// still to be under the point just before pressing, or whatever a point lands on, inside frames
// from other sites too. So a point can't press what a ref wouldn't be allowed to.
import { askWhy, type Verdict } from "@hearth/modules/driver-kit";
import type { DriverContext } from "./context.ts";
import { fail } from "./errors.ts";
import { type Button, click, drag, modifierBits, move, wheel } from "./input.ts";
import { centerOf, checkName, entryOf, hitAt, reaches, type Target } from "./locate.ts";
import { toViewport } from "./vision.ts";

export interface Inspect {
  kind: string;
  label: string;
  verdict: Verdict;
  enter: Verdict;
  click: Verdict;
  editable: boolean;
  password: boolean;
  card: boolean;
  disabled: boolean;
  state: string;
  connected: boolean;
  aimsElsewhere: boolean;
  frame: boolean;
}

export const SUBMIT_INSTEAD = "Use browser_submit, which asks the owner first.";

/** Refuses a press that would send, unless the site is trusted and it's above the floor. */
export async function assertMayPress(
  d: DriverContext,
  t: Target,
  v: Verdict,
  what: string,
): Promise<void> {
  if (!v.sends) return;
  const url = await d.frameUrl(t.session, t.frameId);
  if (d.judge(v, url) === "go") return;
  const trusted = d.trusted(/^https?:/.test(url) ? url : d.url());
  throw fail("would_send", askWhy(what, v, trusted, SUBMIT_INSTEAD));
}

export const inspect = (d: DriverContext, t: Target, how: "click" | "enter") =>
  d.worlds.call<Inspect>(t.session, t.frameId, [t.node], `(h, el) => h.inspect(el, "${how}")`);

/** A ref's element, ready to press: named as read, judged, in view, and where to aim. */
export async function aimRef(d: DriverContext, ref: string, judgeIt: boolean) {
  const e = entryOf(d, ref);
  await checkName(d, e);
  const t: Target = { session: e.session, frameId: e.frameId, node: e.node };
  const info = await inspect(d, t, "click");
  const name = info.label || e.name || ref;
  if (judgeIt) await assertMayPress(d, t, info.click, `Pressing "${name}"`);
  if (info.disabled) throw fail("disabled", `"${name}" is disabled right now.`);
  await d.worlds.call(t.session, t.frameId, [t.node], "(h, el) => h.reveal(el)");
  // A hidden checkbox is pressed through its label, as a person would.
  const aim = info.aimsElsewhere
    ? await d.worlds.callNode(t.session, t.frameId, [t.node], "(h, el) => h.aim(el)")
    : null;
  const center = await centerOf(d, aim ? { ...t, node: aim.backendNodeId } : t);
  if (!center)
    throw fail("covered", `${ref} ("${name}") isn't showing on the page. Read the page again.`);
  return { t, info, name, center };
}

/** Checks a point still lands on the ref's element just before pressing. */
async function assertReaches(
  d: DriverContext,
  t: Target,
  at: { x: number; y: number },
  ref: string,
) {
  const hit = await hitAt(d, at.x, at.y);
  const r = await reaches(d, t, hit);
  if (!r.ok)
    throw fail(
      "covered",
      `Something covers ${ref}${r.by ? ` ("${r.by.slice(0, 60)}")` : ""}. Close it, then read the page again. Nothing was pressed.`,
    );
}

/** What a point in the last screenshot lands on, judged as a press there. */
export async function aimPoint(d: DriverContext, coordinate: [number, number], judgeIt: boolean) {
  const at = await toViewport(d, coordinate);
  const t = await hitAt(d, at.x, at.y);
  const info = await d.worlds.call<{
    kind: string;
    label: string;
    verdict: Verdict;
    canvas: boolean;
  }>(t.session, t.frameId, [t.node], "(h, n) => h.pointAt(n)");
  const name = info.label || info.kind;
  if (judgeIt)
    await assertMayPress(d, t, info.verdict, `Pressing "${name}" at [${coordinate.join(", ")}]`);
  return { at, name };
}

export interface ClickInput {
  ref?: string;
  coordinate?: [number, number];
  button?: Button;
  clickCount?: number;
  modifiers?: string;
}

export async function clickStep(d: DriverContext, i: ClickInput): Promise<string> {
  const button = i.button ?? "left";
  const opts = {
    button,
    clickCount: i.clickCount ?? 1,
    modifiers: modifierBits(i.modifiers),
    still: () => d.assertStill(),
  };
  // Only the left button presses things; a right click opens a menu.
  const presses = button === "left";
  if (i.ref) {
    const { t, name, center } = await aimRef(d, i.ref, presses);
    await assertReaches(d, t, center, i.ref);
    await click(d.cdp, center.x, center.y, opts);
    return `Clicked "${name}" (${i.ref})`;
  }
  if (!i.coordinate) throw fail("invalid", "Give a ref or a coordinate to click.");
  const { at, name } = await aimPoint(d, i.coordinate, presses);
  await click(d.cdp, at.x, at.y, opts);
  return `Clicked "${name}" at [${i.coordinate.join(", ")}]`;
}

export async function hoverStep(
  d: DriverContext,
  i: { ref?: string; coordinate?: [number, number] },
) {
  if (i.ref) {
    const { name, center } = await aimRef(d, i.ref, false);
    await move(d.cdp, center.x, center.y);
    return `Pointed at "${name}" (${i.ref})`;
  }
  if (!i.coordinate) throw fail("invalid", "Give a ref or a coordinate to point at.");
  const { at, name } = await aimPoint(d, i.coordinate, false);
  await move(d.cdp, at.x, at.y);
  return `Pointed at "${name}"`;
}

/** A drag presses where it starts and lets go where it ends: both are judged as presses. */
export async function dragStep(
  d: DriverContext,
  i: { from?: [number, number]; to?: [number, number]; fromRef?: string; toRef?: string },
) {
  const end = async (ref?: string, point?: [number, number]) => {
    if (ref) {
      const a = await aimRef(d, ref, true);
      return { at: a.center, name: a.name };
    }
    if (!point)
      throw fail("invalid", "Give where the drag starts and ends, as refs or coordinates.");
    return aimPoint(d, point, true);
  };
  const a = await end(i.fromRef, i.from);
  const b = await end(i.toRef, i.to);
  await drag(d.cdp, a.at, b.at, () => d.assertStill());
  return `Dragged "${a.name}" to "${b.name}"`;
}

/** How long a wheel gets to start moving the page before it counts as having gone nowhere. */
const SCROLL_START_MS = 600;

/**
 * Where the page stops after a wheel. Chromium scrolls a frame or more after the wheel lands, later
 * on a busy PC, so two equal reads only mean "stopped" once the page has left where it was; one
 * that can't go further stays put for SCROLL_START_MS.
 */
const settledScroll = async (d: DriverContext, from: { x: number; y: number }) => {
  const read = () =>
    d.worlds.evaluate<{ x: number; y: number; w: number; h: number }>(
      undefined,
      d.tab.mainFrame ?? "",
      "__hearth.scroll()",
    );
  const until = Date.now() + SCROLL_START_MS;
  let now = await read();
  while (now.x === from.x && now.y === from.y && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 40));
    now = await read();
  }
  let last = `${now.x},${now.y}`;
  for (let n = 0; n < 12; n++) {
    await new Promise((r) => setTimeout(r, 60));
    now = await read();
    const key = `${now.x},${now.y}`;
    if (key === last) return now;
    last = key;
  }
  return now;
};

export async function scrollStep(
  d: DriverContext,
  i: {
    coordinate?: [number, number];
    direction: "up" | "down" | "left" | "right";
    amount?: number;
  },
) {
  const at = i.coordinate
    ? await toViewport(d, i.coordinate)
    : await (async () => {
        const m = await d.cdp.send<{
          cssVisualViewport: { clientWidth: number; clientHeight: number };
        }>("Page.getLayoutMetrics");
        return { x: m.cssVisualViewport.clientWidth / 2, y: m.cssVisualViewport.clientHeight / 2 };
      })();
  const step = (i.amount ?? 3) * 100;
  const dx = i.direction === "left" ? -step : i.direction === "right" ? step : 0;
  const dy = i.direction === "up" ? -step : i.direction === "down" ? step : 0;
  const from = await d.worlds.evaluate<{ x: number; y: number }>(
    undefined,
    d.tab.mainFrame ?? "",
    "__hearth.scroll()",
  );
  await wheel(d.cdp, at.x, at.y, dx, dy);
  const to = await settledScroll(d, from);
  d.tab.shot = null;
  return {
    did: `Scrolled ${i.direction}`,
    position: { x: Math.round(to.x), y: Math.round(to.y) },
    moved: from.x !== to.x || from.y !== to.y,
    pageSize: { width: Math.round(to.w), height: Math.round(to.h) },
  };
}

export async function scrollToStep(d: DriverContext, ref: string) {
  const e = entryOf(d, ref);
  await checkName(d, e);
  // A frame from another site scrolls its page; the page around it brings the frame into view.
  const frame = e.session ? d.tab.sessions.get(e.session) : undefined;
  const owner = frame ? d.tab.owners.get(frame) : undefined;
  if (owner)
    await d.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: owner.node }, owner.session);
  await d.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: e.node }, e.session);
  d.tab.shot = null;
  return `Scrolled to "${e.name || ref}" (${ref})`;
}
