// Finding things on screen (B1): a ref's node and where it is in the tab's viewport, frames from
// other sites included, and what a point on screen lands on, so a click goes where it was meant
// and nothing slid under it.
import type { DriverContext } from "./context.ts";
import { fail, goneRef, isGone } from "./errors.ts";
import type { RefEntry } from "./refs.ts";

/** A node in a frame, by Chrome's number. */
export interface Target {
  session: string | undefined;
  frameId: string;
  node: number;
}

/** A ref's node, if it's still the page's. */
export function entryOf(d: DriverContext, ref: string): RefEntry {
  const entry = d.tab.refs.get(ref);
  if (!entry) {
    if (/^ref_\d+$/.test(ref)) throw goneRef(ref);
    throw fail(
      "invalid",
      `"${ref}" isn't a ref. Refs look like ref_12, from browser_read_page or browser_find.`,
    );
  }
  return entry;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Checks the node still has the name Jarvis last read, so the page can't swap what's pressed. */
export async function checkName(d: DriverContext, e: RefEntry): Promise<void> {
  const res = await d.cdp
    .send<{ nodes: { name?: { value?: unknown }; ignored?: boolean }[] }>(
      "Accessibility.getPartialAXTree",
      { backendNodeId: e.node, fetchRelatives: false },
      e.session,
    )
    .catch((err) => {
      if (isGone(err)) throw goneRef(e.ref);
      throw err;
    });
  const now = String(res.nodes[0]?.name?.value ?? "");
  if (e.name && norm(now) !== norm(e.name))
    throw fail(
      "changed",
      `The page changed: ${e.ref} is now ${now ? `"${now.slice(0, 80)}"` : "unnamed"}, not "${e.name.slice(0, 80)}". Nothing was done; read the page again.`,
    );
}

/** Where a frame session's page sits in the tab's viewport. */
async function offsetOf(
  d: DriverContext,
  session: string | undefined,
  depth = 0,
): Promise<{ x: number; y: number }> {
  if (!session || depth > 5) return { x: 0, y: 0 };
  const frame = d.tab.sessions.get(session);
  const owner = frame ? d.tab.owners.get(frame) : undefined;
  if (!owner) throw fail("gone", "That frame isn't on the page any more. Read the page again.");
  const box = await d.cdp.send<{ model: { content: number[] } }>(
    "DOM.getBoxModel",
    { backendNodeId: owner.node },
    owner.session,
  );
  const above = await offsetOf(d, owner.session, depth + 1);
  return { x: above.x + (box.model.content[0] ?? 0), y: above.y + (box.model.content[1] ?? 0) };
}

/** The middle of a node in the tab's viewport, in CSS pixels, or null if it has no box. */
export async function centerOf(
  d: DriverContext,
  t: Target,
): Promise<{ x: number; y: number } | null> {
  const res = await d.cdp
    .send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: t.node }, t.session)
    .catch((err) => {
      if (isGone(err) || /Could not compute content quads/i.test(String(err))) return { quads: [] };
      throw err;
    });
  const quad = res.quads.find(
    (q) => Math.abs((q[4] ?? 0) - (q[0] ?? 0)) >= 1 && Math.abs((q[5] ?? 0) - (q[1] ?? 0)) >= 1,
  );
  if (!quad) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  const off = await offsetOf(d, t.session);
  return {
    x: off.x + (Math.min(...xs) + Math.max(...xs)) / 2,
    y: off.y + (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/** The node in another node's frame that holds it: an <iframe>'s own page from another site. */
async function frameInside(d: DriverContext, session: string | undefined, node: number) {
  const desc = await d.cdp.send<{ node: { nodeName: string; frameId?: string } }>(
    "DOM.describeNode",
    { backendNodeId: node },
    session,
  );
  if (!/^(IFRAME|FRAME)$/i.test(desc.node.nodeName) || !desc.node.frameId) return null;
  const child = d.tab.sessionOf(desc.node.frameId);
  if (!child) return null;
  d.tab.owners.set(desc.node.frameId, { session, node });
  return child;
}

/** How far a session's page is scrolled: the tab's own, or a frame's from another site. */
async function scrollOf(d: DriverContext, session: string | undefined) {
  if (!session) {
    const m = await d.cdp.send<{ cssLayoutViewport: { pageX: number; pageY: number } }>(
      "Page.getLayoutMetrics",
    );
    return { x: m.cssLayoutViewport.pageX, y: m.cssLayoutViewport.pageY };
  }
  const frame = d.tab.sessions.get(session);
  if (!frame) throw fail("gone", "That frame isn't on the page any more. Read the page again.");
  return d.worlds.evaluate<{ x: number; y: number }>(session, frame, "__hearth.scroll()");
}

/**
 * What a click at a point in the tab's viewport would land on, inside frames from other sites
 * too: the deepest node, in its own frame.
 */
export async function hitAt(d: DriverContext, x: number, y: number): Promise<Target> {
  let session: string | undefined;
  let lx = x;
  let ly = y;
  for (let depth = 0; ; depth++) {
    // Chrome takes the point in the frame's document, so a scrolled page's scroll is added.
    const scroll = await scrollOf(d, session);
    const hit = await d.cdp
      .send<{ backendNodeId: number; frameId: string }>(
        "DOM.getNodeForLocation",
        {
          x: Math.round(lx + scroll.x),
          y: Math.round(ly + scroll.y),
          includeUserAgentShadowDOM: false,
        },
        session,
      )
      .catch((err) => {
        if (/No node found/i.test(String(err)))
          throw fail("not_found", "There's nothing on the page at that point.");
        throw err;
      });
    const inner = depth < 5 ? await frameInside(d, session, hit.backendNodeId) : null;
    if (!inner) return { session, frameId: hit.frameId, node: hit.backendNodeId };
    const off = await offsetOf(d, inner);
    lx = x - off.x;
    ly = y - off.y;
    session = inner;
  }
}

/**
 * Whether a click at the point reaches the target, and if not, what's in the way: an overlay, a
 * banner, or something the page slid under it.
 */
export async function reaches(
  d: DriverContext,
  t: Target,
  hit: Target,
): Promise<{ ok: boolean; by: string }> {
  if (hit.session !== t.session || hit.frameId !== t.frameId)
    return { ok: false, by: "another frame" };
  if (hit.node === t.node) return { ok: true, by: "" };
  return d.worlds.call(
    t.session,
    t.frameId,
    [t.node, hit.node],
    "(h, el, hit) => h.reaches(el, hit)",
  );
}
