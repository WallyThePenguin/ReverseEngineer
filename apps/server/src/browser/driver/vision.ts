// Looking at a tab (B1): screenshots at the page's own CSS scale, never more than 1568 pixels on
// the long side, with the numbers that turn a point in the picture back into the page's
// coordinates; and zooming in on a part of one.
import type { DriverContext } from "./context.ts";
import { fail } from "./errors.ts";
import type { ShotMeta } from "./tab.ts";

/** The longest side of a picture Jarvis gets. */
export const LONG_EDGE = 1568;
/** A background tab Chrome isn't drawing doesn't hold a step up longer than this. */
const CAPTURE_MS = 8_000;

interface Metrics {
  cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number };
}

/** The viewport in CSS pixels, where it's scrolled to, and the screen's pixel ratio. */
async function view(d: DriverContext) {
  const main = d.tab.mainFrame ?? "";
  const [m, s] = await Promise.all([
    d.cdp.send<Metrics>("Page.getLayoutMetrics"),
    d.worlds
      .evaluate<{ dpr: number }>(undefined, main, "__hearth.scroll()")
      .catch(() => ({ dpr: 1 })),
  ]);
  const v = m.cssVisualViewport;
  return {
    cssW: v.clientWidth,
    cssH: v.clientHeight,
    scrollX: v.pageX,
    scrollY: v.pageY,
    dpr: s.dpr || 1,
  };
}

/** How a picture of the viewport at `want` scale would map to the page. */
export function shotMeta(v: Awaited<ReturnType<typeof view>>, want = 1): ShotMeta {
  const scale = Math.min(want, LONG_EDGE / Math.max(v.cssW, v.cssH, 1));
  return {
    ...v,
    scale,
    imageW: Math.round(v.cssW * scale),
    imageH: Math.round(v.cssH * scale),
  };
}

/** Chrome draws only the tab in front: Jarvis's own tab comes to the front of its window. */
async function drawn(d: DriverContext): Promise<void> {
  const tabs = await d.transport
    .call<{ tabId: number; handed: boolean }[]>("tabs.list")
    .catch(() => []);
  const tab = tabs.find((t) => t.tabId === d.tab.tabId);
  if (tab && !tab.handed)
    await d.transport.call("tabs.show", { tabId: d.tab.tabId }).catch(() => {});
}

async function capture(d: DriverContext, clip: Record<string, number>, format: "jpeg" | "png") {
  try {
    const res = await d.cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format,
        ...(format === "jpeg" ? { quality: 80 } : {}),
        clip,
        fromSurface: true,
        captureBeyondViewport: false,
      },
      undefined,
      CAPTURE_MS,
    );
    return res.data;
  } catch (err) {
    if (/didn't answer|timed? ?out/i.test(String(err)))
      throw fail(
        "timeout",
        "Chrome isn't drawing that tab (it's behind another window or tab). Bring it to the front, or use browser_read_page.",
      );
    throw err;
  }
}

/** A picture of what the tab shows, and how its pixels map to the page. */
export async function screenshot(d: DriverContext, want = 1) {
  await d.seed();
  await drawn(d);
  const meta = shotMeta(await view(d), want);
  const data = await capture(
    d,
    {
      x: meta.scrollX,
      y: meta.scrollY,
      width: meta.cssW,
      height: meta.cssH,
      scale: meta.scale / meta.dpr,
    },
    "jpeg",
  );
  d.tab.shot = meta;
  return { meta, image: { mimeType: "image/jpeg" as const, data } };
}

/** The last screenshot's mapping, or the one a screenshot now would have. */
export async function currentShot(d: DriverContext): Promise<ShotMeta> {
  return d.tab.shot ?? shotMeta(await view(d));
}

/** A point in the last screenshot as CSS pixels in the tab's viewport. */
export async function toViewport(d: DriverContext, [x, y]: [number, number]) {
  const meta = await currentShot(d);
  if (x < 0 || y < 0 || x > meta.imageW || y > meta.imageH)
    throw fail(
      "invalid",
      `[${x}, ${y}] is outside the screenshot, which is ${meta.imageW}×${meta.imageH}.`,
    );
  return { x: x / meta.scale, y: y / meta.scale };
}

/** A closer look at a part of the last screenshot: [x0, y0, x1, y1] in its pixels. */
export async function zoom(
  d: DriverContext,
  region: [number, number, number, number],
  want?: number,
) {
  await d.seed();
  await drawn(d);
  const meta = await currentShot(d);
  const [x0, y0, x1, y1] = region;
  if (x1 <= x0 || y1 <= y0)
    throw fail("invalid", "Give the region as [x0, y0, x1, y1], top left to bottom right.");
  const width = (x1 - x0) / meta.scale;
  const height = (y1 - y0) / meta.scale;
  const now = await view(d);
  const scale = Math.min(want ?? 4, LONG_EDGE / Math.max(width, height));
  const data = await capture(
    d,
    {
      x: now.scrollX + x0 / meta.scale,
      y: now.scrollY + y0 / meta.scale,
      width,
      height,
      scale: scale / now.dpr,
    },
    "png",
  );
  return {
    image: { mimeType: "image/png" as const, data },
    region,
    imageW: Math.round(width * scale),
    imageH: Math.round(height * scale),
  };
}
