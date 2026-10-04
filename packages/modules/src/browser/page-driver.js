// @ts-check
// Runs inside a web page, in an isolated world the page's own scripts can't see: the page side
// of the server's driver (B1). It finds what a person can press or type into, including things a
// page made clickable without saying so (a <div> with a pointer cursor), says what pressing each
// would do (page-elements.js's classify), and helps the driver act: what to aim at for a hidden
// checkbox, whether what a click would land on is the thing meant, and setting a list, a box, a
// date or a slider the way a person would. Nothing is ever written into the page: elements are
// remembered in this world's own WeakMap, by the node numbers Chrome gave them. One
// self-contained function, sent as source; `h` is page-elements.js.

/**
 * @param {PageElements} h
 */
// biome-ignore lint/correctness/noUnusedVariables: sent to the page as source text.
function pageDriver(h) {
  /** Chrome's node number for each element the driver has seen, in this world only. */
  const ids = new WeakMap();
  /** @type {Element[]} */
  let scanned = [];
  /** The ones found by look alone. */
  let extras = new Set();
  const MAX = 600;
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, details, label[for], [role], [onclick], [tabindex], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  /** @param {Element} el */
  function box(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** Seen by a person: laid out, not hidden, not see-through. @param {Element} el */
  function visible(el, opacity = true) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const check = /** @type {any} */ (el).checkVisibility;
    if (typeof check === "function")
      return check.call(el, { opacityProperty: opacity, visibilityProperty: true });
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && (!opacity || s.opacity !== "0");
  }

  /** A real control a page hid to draw its own (an opacity-0 checkbox). @param {Element} el */
  function hiddenControl(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    const r = el.getBoundingClientRect();
    return !visible(el) || r.width <= 2 || r.height <= 2;
  }

  /** What to aim at to press it: a hidden control's label, or the element itself. @param {Element} el */
  function aimAt(el) {
    if (!hiddenControl(el)) return el;
    const input = /** @type {HTMLInputElement} */ (el);
    for (const label of input.labels ?? []) if (visible(label)) return label;
    for (let a = el.parentElement; a; a = a.parentElement) if (visible(a)) return a;
    return el;
  }

  /** The parent across shadow roots. @param {Node} n @returns {Node | null} */
  const up = (n) => n.parentNode ?? /** @type {ShadowRoot} */ (n).host ?? null;

  /** Whether `inner` is `outer` or inside it, shadow roots included. @param {Node} outer @param {Node} inner */
  function holds(outer, inner) {
    for (let n = /** @type {Node | null} */ (inner); n; n = up(n)) if (n === outer) return true;
    return false;
  }

  /**
   * The nearest element a person could press, from where a point landed: a control or a link,
   * or else what the page made clickable itself; failing those, where it `landed`.
   * @param {Node} n
   */
  function pressable(n) {
    /** @type {Element | null} */
    let made = null;
    for (let a = /** @type {Node | null} */ (n); a; a = up(a)) {
      if (!(a instanceof Element)) continue;
      if (h.kindOf(a) !== null || a instanceof HTMLAnchorElement) return { el: a, landed: false };
      if (!made && looksClickable(a)) made = a;
      if (a === document.body) break;
    }
    if (made) return { el: made, landed: false };
    return { el: n instanceof Element ? n : (n.parentElement ?? document.body), landed: true };
  }

  /** Clickable by look alone: a pointer cursor its parent doesn't have. @param {Element} el */
  function looksClickable(el) {
    if (getComputedStyle(el).cursor !== "pointer") return false;
    const parent = el.parentElement;
    return !parent || getComputedStyle(parent).cursor !== "pointer";
  }

  /**
   * What a click on it would do. A link to a page only opens it; anything else without a role
   * (a <div> the page made clickable) is judged by its name, as a button is, since its script
   * can't be seen. So a ref or a point can't press "Delete account" just for lacking a role.
   * @param {Element} el
   */
  function clickVerdict(el) {
    const page = el instanceof HTMLAnchorElement && el.hasAttribute("href");
    return h.classify(el, "click", h.kindOf(el) === null && !page);
  }

  /** @param {Element} el @param {boolean} extra */
  function describe(el, extra) {
    const kind = h.kindOf(el);
    // What a click does: typing into a field is free, and Enter there is judged when pressed.
    const v = clickVerdict(el);
    const hidden = hiddenControl(el);
    return {
      id: ids.get(el) ?? 0,
      kind: kind ?? (el instanceof HTMLAnchorElement ? "link" : "clickable"),
      label: h.labelOf(el),
      sends: v.sends,
      floor: v.floor,
      why: v.why,
      state: h.stateOf(el),
      card: h.isCard(el),
      extra,
      hidden,
      shown: hidden ? visible(aimAt(el)) : visible(el),
      href: el instanceof HTMLAnchorElement ? el.href : "",
    };
  }

  return {
    /**
     * What a person can press or type into, and what each would do. The elements come back as
     * an array for the driver to number; `info` says what each is, in the same order.
     */
    scan() {
      const seen = new Set(h.findAll(INTERACTIVE));
      const out = [...seen].filter((el) => !(el instanceof HTMLLabelElement));
      const extra = new Set();
      let looked = 0;
      for (const el of h.findAll("div, span, li, img, svg, td, p, i")) {
        if (++looked > 4000 || out.length >= MAX) break;
        if (seen.has(el) || !looksClickable(el) || !visible(el)) continue;
        out.push(el);
        extra.add(el);
      }
      scanned = out.slice(0, MAX);
      extras = extra;
      return scanned;
    },
    /** What the last scan found, in its order. */
    info() {
      return JSON.stringify(scanned.map((el) => describe(el, extras.has(el))));
    },
    /** The driver says which node numbers Chrome gave the last scan's elements. @param {number[]} list */
    learn(list) {
      list.forEach((id, n) => {
        const el = scanned[n];
        if (el && id) ids.set(el, id);
      });
    },
    /** @param {Element} el @param {"click" | "enter"} how */
    inspect(el, how) {
      const kind = h.kindOf(el);
      const click = clickVerdict(el);
      const v = how === "click" ? click : h.classify(el, how);
      const editable =
        kind === "field" ||
        kind === "password field" ||
        kind === "text area" ||
        (el instanceof HTMLElement && el.isContentEditable);
      return {
        kind: kind ?? (el instanceof HTMLAnchorElement ? "link" : el.tagName.toLowerCase()),
        label: h.labelOf(el),
        verdict: v,
        enter: how === "enter" ? v : h.classify(el, "enter"),
        click,
        editable,
        password: kind === "password field",
        card: h.isCard(el),
        disabled:
          Boolean(/** @type {any} */ (el).disabled) || el.getAttribute("aria-disabled") === "true",
        state: h.stateOf(el),
        connected: el.isConnected,
        aimsElsewhere: aimAt(el) !== el,
        box: box(aimAt(el)),
        frame: /^(IFRAME|FRAME)$/.test(el.tagName),
      };
    },
    /** The element to aim a click at. @param {Element} el */
    aim: aimAt,
    /** Brings it into view, if it isn't. @param {Element} el */
    reveal(el) {
      const target = aimAt(el);
      const r = target.getBoundingClientRect();
      const inside = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      if (!inside)
        target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return box(target);
    },
    /** Whether a click that landed on `hit` reaches `el`, and what's in the way if not. @param {Element} el @param {Node} hit */
    reaches(el, hit) {
      const target = aimAt(el);
      if (holds(target, hit) || holds(el, hit)) return { ok: true, by: "" };
      // A click on a control's label reaches the control.
      const label = hit instanceof Element ? hit.closest("label") : null;
      if (label && /** @type {HTMLLabelElement} */ (label).control === el)
        return { ok: true, by: "" };
      const top = pressable(hit).el;
      return { ok: false, by: h.labelOf(top) || top.tagName.toLowerCase() };
    },
    /** What a press at a point would do, from where it landed. @param {Node} hit */
    pointAt(hit) {
      const { el, landed } = pressable(hit);
      const v = landed ? h.classify(el, "click") : clickVerdict(el);
      return {
        kind: h.kindOf(el) ?? el.tagName.toLowerCase(),
        label: h.labelOf(el),
        verdict: v,
        frame: /^(IFRAME|FRAME)$/.test(el.tagName),
        canvas: el.tagName === "CANVAS",
      };
    },
    /** What has the keyboard's focus in this document, shadow roots included. */
    active() {
      let a = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      if (!a || a === document.body || a === document.documentElement) return null;
      return a;
    },
    /** Puts the cursor in a field, selecting what's there when it's to be replaced. @param {Element} el @param {boolean} clear */
    focus(el, clear) {
      if (el instanceof HTMLElement) el.focus();
      if (clear) {
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
      let a = root.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      return a === el || holds(el, /** @type {Node} */ (a));
    },
    /**
     * Sets a list, a checkbox or radio, a date, a slider or a box of text to a value, as a person
     * would end up with it, and tells the page with input and change events.
     * @param {Element} el @param {string} value
     */
    setValue(el, value) {
      const want = value.trim();
      const fire = () => {
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (el instanceof HTMLSelectElement) {
        const options = [...el.options];
        const low = want.toLowerCase();
        const match =
          options.find((o) => o.text.trim().toLowerCase() === low) ??
          options.find((o) => o.value.toLowerCase() === low) ??
          options.find((o) => o.text.trim().toLowerCase().startsWith(low));
        if (!match)
          return {
            error: `No option "${want}". The options are: ${options
              .map((o) => h.clean(o.text))
              .slice(0, 30)
              .join("; ")}`,
          };
        if (match.disabled) return { error: `"${match.text.trim()}" can't be chosen right now.` };
        el.value = match.value;
        fire();
        return { now: h.stateOf(el) };
      }
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const on = /^(on|yes|true|checked|chosen|1)$/i.test(want);
        const off = /^(off|no|false|unchecked|0)$/i.test(want);
        if (!on && !off) return { error: 'Say "on" or "off" for a checkbox or a radio button.' };
        if (el.type === "radio" && off) return { error: "Choose another option to clear a radio." };
        // A click, as a person makes it, so the page's own handlers see it.
        if (el.checked !== on) el.click();
        return { now: h.stateOf(el), checked: el.checked };
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
        el.focus();
        if (setter) setter.call(el, want);
        else el.value = want;
        if (el.value !== want && el instanceof HTMLInputElement && el.type !== "text")
          return { error: `"${want}" isn't a value this ${el.type} field takes.` };
        fire();
        return { now: el.value };
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        el.focus();
        el.textContent = want;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        return { now: h.clean(el.innerText) };
      }
      const role = el.getAttribute("role");
      if (role === "checkbox" || role === "switch" || role === "radio") {
        const on = /^(on|yes|true|checked|1)$/i.test(want);
        if (String(el.getAttribute("aria-checked") === "true") !== String(on))
          /** @type {HTMLElement} */ (el).click();
        return { now: el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked" };
      }
      return {
        error: `That's a ${h.kindOf(el) ?? el.tagName.toLowerCase()}, not something with a value.`,
      };
    },
    /** What pressing it would send: the page and its form's fields, for the owner's card. @param {Element} el */
    form(el) {
      const owner = /** @type {{ form?: HTMLFormElement | null }} */ (el);
      const form = owner.form ?? el.closest("form");
      const fields = (form ? [...form.querySelectorAll("*")] : h.findAll("*")).filter((f) => {
        const kind = h.kindOf(f);
        if (!kind || !/field|text area|select|checkbox|radio/.test(kind)) return false;
        if (kind === "password field" || kind === "file field" || h.isCard(f)) return false;
        const r = f.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      /** @param {Element} f */
      const shown = (f) => {
        if (f instanceof HTMLSelectElement) return f.selectedOptions[0]?.text ?? "";
        if (f instanceof HTMLInputElement && (f.type === "checkbox" || f.type === "radio"))
          return f.checked ? "on" : "off";
        if (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) return f.value;
        return f instanceof HTMLElement ? f.innerText : (f.textContent ?? "");
      };
      return {
        url: location.href.split("#")[0],
        fields: fields.slice(0, 20).map((f) => ({
          label: h.labelOf(f) || h.kindOf(f) || "field",
          value: shown(f).replace(/\s+/g, " ").trim().slice(0, 300),
        })),
      };
    },
    /** Waits until the page stops changing for `ms`, or `max` passes. @param {number} ms @param {number} max */
    quiet(ms, max) {
      return new Promise((resolve) => {
        const start = Date.now();
        let timer = setTimeout(done, ms);
        const watch = new MutationObserver(() => {
          clearTimeout(timer);
          if (Date.now() - start < max) timer = setTimeout(done, ms);
          else done();
        });
        function done() {
          watch.disconnect();
          resolve(Date.now() - start);
        }
        watch.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        setTimeout(done, max);
      });
    },
    /** Where the page is scrolled to and how big it is. */
    scroll() {
      const s = document.scrollingElement ?? document.documentElement;
      return { x: scrollX, y: scrollY, w: s.scrollWidth, h: s.scrollHeight, dpr: devicePixelRatio };
    },
  };
}
