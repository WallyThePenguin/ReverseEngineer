// Reading a page as its accessibility tree (B1, D52): what a screen reader would announce, frame by
// frame, frames from other sites included (each in its own child session), merged with a pass in
// Hearth's isolated world that finds what a page made clickable without saying so and says what
// pressing each thing would do. Things get refs ("ref_12") that stay the same across reads.
import type { Floor } from "@hearth/modules/driver-kit";
import type { DriverContext } from "./context.ts";
import { isGone } from "./errors.ts";

interface AXValue {
  type: string;
  value?: unknown;
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** What the isolated world says about one element (page-driver.js's describe). */
export interface Seen {
  id: number;
  kind: string;
  label: string;
  sends: boolean;
  floor: Floor | null;
  why: string;
  state: string;
  card: boolean;
  extra: boolean;
  hidden: boolean;
  shown: boolean;
  href: string;
}

/** One thing on the page as Jarvis reads it. */
export interface Line {
  ref?: string;
  role: string;
  name: string;
  value?: string;
  props: string[];
  url?: string;
  /** Pressing it would need the owner's yes here: why. */
  asks?: string;
  interactive: boolean;
  text?: boolean;
  /** For a frame: the site its page is from. */
  site?: string;
  children: Line[];
}

export const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "listbox",
  "treeitem",
  "disclosuretriangle",
  "colorwell",
  "date",
  "datetime",
  "inputtime",
  "popupbutton",
  "togglebutton",
  "clickable",
]);
const SKIP = new Set(["inlinetextbox", "linebreak", "listmarker"]);
const PLAIN = new Set([
  "generic",
  "none",
  "presentation",
  "group",
  "rootwebarea",
  "webarea",
  "paragraph",
  "section",
  "div",
  "labeltext",
  "menulistpopup",
]);
/** Controls whose insides are the browser's own parts (a date's month, day and year boxes). */
const SEALED = new Set(["date", "datetime", "inputtime", "colorwell"]);
const MAX_FRAMES = 20;

const str = (v: AXValue | undefined) =>
  (v?.value === undefined ? "" : String(v.value)).replace(/\s+/g, " ").trim();

function propsOf(node: AXNode): { props: string[]; url?: string } {
  const props: string[] = [];
  let url: string | undefined;
  for (const p of node.properties ?? []) {
    const v = p.value?.value;
    switch (p.name) {
      case "checked":
        props.push(v === "mixed" ? "mixed" : v === "true" || v === true ? "checked" : "unchecked");
        break;
      case "pressed":
        if (v === "true" || v === true) props.push("pressed");
        break;
      case "selected":
        if (v === true) props.push("selected");
        break;
      case "expanded":
        props.push(v ? "expanded" : "collapsed");
        break;
      case "disabled":
      case "required":
      case "focused":
      case "modal":
        if (v === true) props.push(p.name);
        break;
      case "readonly":
        if (v === true) props.push("read-only");
        break;
      case "level":
        props.push(`level ${v}`);
        break;
      case "url":
        url = String(v);
        break;
    }
  }
  return { props, url };
}

/** The world's view of a frame: what each element is and would do, by Chrome's node numbers. */
async function scanFrame(d: DriverContext, session: string | undefined, frameId: string) {
  const array = await d.worlds.handle(session, frameId, "__hearth.scan()");
  const info = JSON.parse(
    await d.worlds.evaluate<string>(session, frameId, "__hearth.info()"),
  ) as Seen[];
  // Only the ones whose ref needs the world's word: what sends, what looks clickable, hidden boxes.
  const need = info.flatMap((x, n) => (!x.id && (x.sends || x.extra || x.hidden) ? [n] : []));
  if (need.length && array) {
    const ids = await d.worlds.nodesOf(session, array, need);
    for (const [n, id] of ids) if (info[n]) info[n].id = id;
    await d.worlds.evaluate(
      session,
      frameId,
      `__hearth.learn(${JSON.stringify(info.map((x) => x.id))})`,
    );
  }
  return new Map(info.filter((x) => x.id).map((x) => [x.id, x]));
}

interface Walk {
  d: DriverContext;
  frames: number;
  refreshed: boolean;
  links: Set<string>;
}

/** One frame's lines: its accessibility tree, with the world's word on each element. */
async function frameLines(w: Walk, session: string | undefined, frameId: string): Promise<Line[]> {
  const { d } = w;
  if (++w.frames > MAX_FRAMES) return [];
  const own = frameId === d.tab.rootFrame(session);
  const [ax, seen] = await Promise.all([
    d.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", own ? {} : { frameId }, session),
    scanFrame(d, session, frameId).catch((err) => {
      if (isGone(err)) return new Map<number, Seen>();
      throw err;
    }),
  ]);
  const byId = new Map(ax.nodes.map((n) => [n.nodeId, n]));
  const frameUrl = await d.frameUrl(session, frameId);

  const walk = async (node: AXNode, parentName: string): Promise<Line[]> => {
    const role = str(node.role).toLowerCase();
    const name = str(node.name);
    const kids = async (pn: string) => {
      const out: Line[] = [];
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) out.push(...(await walk(child, pn)));
      }
      // A label's words beside the control they name say nothing new.
      const named = new Set(out.filter((l) => l.interactive).map((l) => l.name));
      return out.filter((l) => !l.text || !named.has(l.name));
    };
    if (SKIP.has(role)) return [];
    const backend = node.backendDOMNodeId;
    const info = backend ? seen.get(backend) : undefined;
    const extra = Boolean(info?.extra);
    if (node.ignored && !extra) return kids(parentName);
    if (role === "statictext") {
      if (!name || name === parentName) return [];
      return [
        {
          role: "text",
          name: name.slice(0, 300),
          props: [],
          interactive: false,
          text: true,
          children: [],
        },
      ];
    }
    if (role === "iframe" && backend) return [await frameLine(w, session, backend, name)];
    const plain = PLAIN.has(role) && !(role === "group" && name) && !extra;
    if (plain || !backend) return kids(role === "paragraph" && name ? name : parentName);
    const shownRole = extra && !INTERACTIVE.has(role) ? "clickable" : role;
    const { props, url } = propsOf(node);
    const line: Line = {
      ref: d.tab.refs.refFor(session, frameId, backend, shownRole, name),
      role: shownRole,
      name: name || (extra ? (info?.label ?? "") : ""),
      props,
      interactive: INTERACTIVE.has(shownRole),
      children: [],
    };
    const value = str(node.value);
    if (value && value !== name) line.value = value.slice(0, 200);
    if (url) {
      line.url = url;
      w.links.add(url);
    }
    if (info?.sends && d.judge(info, frameUrl) === "ask")
      line.asks = info.floor ? `asks owner: ${info.floor}` : "asks owner";
    line.children = SEALED.has(shownRole) ? [] : await kids(name);
    return [line];
  };

  const root = ax.nodes[0];
  return root ? walk(root, "") : [];
}

/** An <iframe> and the page inside it, from the same site's process or its own child session. */
async function frameLine(
  w: Walk,
  session: string | undefined,
  node: number,
  name: string,
): Promise<Line> {
  const { d } = w;
  const line: Line = { role: "iframe", name, props: [], interactive: false, children: [] };
  line.ref = d.tab.refs.refFor(session, d.tab.rootFrame(session) ?? "", node, "iframe", name);
  try {
    const desc = await d.cdp.send<{ node: { frameId?: string } }>(
      "DOM.describeNode",
      { backendNodeId: node },
      session,
    );
    const frameId = desc.node.frameId;
    if (!frameId) return line;
    let child = d.tab.sessionOf(frameId);
    if (!child && !d.tab.frames.has(frameId) && !w.refreshed) {
      // Frames that came while Hearth wasn't listening: ask the extension which it attached.
      w.refreshed = true;
      await d.refreshSessions();
      child = d.tab.sessionOf(frameId);
    }
    if (child) d.tab.owners.set(frameId, { session, node });
    line.children = await frameLines(w, child ?? session, frameId);
    const url = d.tab.frames.get(frameId)?.url;
    if (url) line.site = siteOf(url);
  } catch (err) {
    if (!isGone(err)) throw err;
    line.props.push("can't see inside");
  }
  return line;
}

function siteOf(url: string): string {
  try {
    return new URL(url).host || url.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

/** The whole page, every frame, as lines; and the link addresses it showed. */
export async function readTree(d: DriverContext): Promise<{ lines: Line[]; links: string[] }> {
  await d.seed();
  const main = d.tab.mainFrame;
  if (!main) return { lines: [], links: [] };
  const w: Walk = { d, frames: 0, refreshed: false, links: new Set() };
  const lines = await frameLines(w, undefined, main);
  return { lines, links: [...w.links] };
}
