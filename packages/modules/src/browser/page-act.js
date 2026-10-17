// @ts-check
// Runs inside a web page: finds something the page reader numbered ("E4"), scrolls it into view
// and says where it is, what it is, and whether pressing it would send something. It can also
// focus a field for typing or pick an option in a list. Clicks and keys themselves go through
// Chrome's input events, as if a person did them. One self-contained function, sent as source;
// `h` is page-elements.js.

/**
 * @param {{ ref: string, op: "inspect" | "focus" | "choose", clear?: boolean, value?: string,
 *   doc?: number, mark?: string }} opts
 * @param {PageElements} h
 */
// biome-ignore lint/correctness/noUnusedVariables: sent to the page as source text.
function pageAct(opts, h) {
  // Only on Jarvis's side of things: never on Hearth's own page (one back from the cache keeps
  // its references), and only on the page the reference was read from (`doc`, when it began).
  // Both before anything here is touched.
  if (opts.mark && document.querySelector(opts.mark)) return { hearth: true };
  if (opts.doc !== undefined && opts.doc !== performance.timeOrigin) return { moved: true };
  if (!/^E\d+$/.test(opts.ref)) return { missing: true };
  const [el] = h.findAll(`[data-hearth="${opts.ref}"]`);
  if (!el?.isConnected) return { missing: true };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;

  // What a click at its middle would land on: a dialog or an overlay may be in the way.
  let top = document.elementFromPoint(x, y);
  while (top?.shadowRoot) {
    const inner = top.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  const labelFor = top instanceof HTMLLabelElement && top.control === el;
  const covered =
    r.width === 0 || r.height === 0 || (top !== null && !el.contains(top) && !labelFor);
  const kind = h.kindOf(el);
  const typing = kind === "field" || kind === "password field";
  const verdict = h.classify(el, typing ? "enter" : "click");

  const info = {
    missing: false,
    /** Where the page is now, which a step judges its site and trust by. */
    href: location.href,
    kind: kind ?? "element",
    label: h.labelOf(el),
    /** Pressing it (Enter, for a field) would send something; floor and why say more. */
    submits: verdict.sends,
    floor: verdict.floor,
    why: verdict.why,
    /** A field for card or bank details, which Jarvis never types. */
    card: h.isCard(el),
    state: h.stateOf(el),
    disabled:
      Boolean(/** @type {any} */ (el).disabled) || el.getAttribute("aria-disabled") === "true",
    x,
    y,
    covered,
    coveredBy: covered && top ? h.labelOf(top) || top.tagName.toLowerCase() : null,
    // A plain link to a page is opened by its address. Tabs and menu items are clicked like any
    // button, even when they're links underneath.
    isLink: el instanceof HTMLAnchorElement && kind === null,
    focused: false,
    /** For "choose": the checkbox must be clicked to reach the state asked for. */
    toggle: false,
    error: /** @type {string | null} */ (null),
  };

  if (opts.op === "focus") {
    if (el instanceof HTMLElement) el.focus();
    if (opts.clear) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
      else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
    const root = /** @type {Document | ShadowRoot} */ (el.getRootNode());
    info.focused = root.activeElement === el;
  }

  if (opts.op === "choose") {
    const want = (opts.value ?? "").trim().toLowerCase();
    if (el instanceof HTMLSelectElement) {
      const options = [...el.options];
      const match =
        options.find((o) => o.text.trim().toLowerCase() === want) ??
        options.find((o) => o.value.toLowerCase() === want) ??
        options.find((o) => o.text.trim().toLowerCase().startsWith(want));
      if (!match) {
        const names = options.map((o) => h.clean(o.text)).slice(0, 30);
        info.error = `No option "${opts.value}". The options are: ${names.join("; ")}`;
      } else if (!match.disabled) {
        el.value = match.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        info.state = h.stateOf(el);
      } else info.error = `"${match.text.trim()}" can't be chosen right now.`;
    } else if (info.kind === "checkbox" || info.kind === "radio") {
      const on = /^(on|yes|true|checked|chosen|1)$/.test(want);
      const off = /^(off|no|false|unchecked|0)$/.test(want);
      if (!on && !off) info.error = 'Say "on" or "off" for a checkbox or a radio button.';
      else {
        const now = /checked|chosen/.test(info.state) && !/unchecked|not chosen/.test(info.state);
        if (info.kind === "radio" && off) info.error = "Choose another option to clear a radio.";
        else info.toggle = now !== on;
      }
    } else info.error = `${opts.ref} is a ${info.kind}, not a list or a checkbox.`;
  }
  return info;
}
