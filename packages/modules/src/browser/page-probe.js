// @ts-check
// Runs inside a web page: small checks the browser's hands make around a step. "active" says
// what has the keyboard's focus and what Enter or Space would do there, "hit" whether a click at
// a point would still land on the element meant, "form" what a submit would send (each field's
// name and what's in it), so the approval card can show it and the press can be refused if it
// changed, and "consent" finds a cookie banner's "reject all" button. One self-contained
// function, sent as source; `h` is page-elements.js.

/**
 * @param {{ op: "active" | "hit" | "form" | "consent", ref?: string, x?: number, y?: number,
 *   reject?: string, doc?: number, mark?: string }} opts
 * @param {PageElements} h
 */
// biome-ignore lint/correctness/noUnusedVariables: sent to the page as source text.
function pageProbe(opts, h) {
  const marked = () =>
    opts.ref && /^(E\d+|C1)$/.test(opts.ref)
      ? (h.findAll(`[data-hearth="${opts.ref}"]`)[0] ?? null)
      : null;

  /** What a click at a point lands on, inside open shadow roots too. @param {number} x @param {number} y */
  const topAt = (x, y) => {
    let top = document.elementFromPoint(x, y);
    while (top?.shadowRoot) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return top;
  };

  if (opts.op === "active") {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    if (!a || a === document.body || a === document.documentElement)
      return { kind: null, editable: false };
    const kind = h.kindOf(a);
    const editable =
      kind === "field" ||
      kind === "password field" ||
      kind === "text area" ||
      (a instanceof HTMLElement && a.isContentEditable);
    return {
      kind,
      label: h.labelOf(a),
      editable,
      password: kind === "password field",
      // A payment provider's frame holds card fields, which Jarvis never types into.
      card: h.isCard(a),
      enter: h.classify(a, "enter"),
      click: h.classify(a, "click"),
    };
  }

  if (opts.op === "hit") {
    // As pageAct: the page the reference was read from, and not Hearth's own.
    if (opts.mark && document.querySelector(opts.mark)) return { ok: false, hearth: true };
    if (opts.doc !== undefined && opts.doc !== performance.timeOrigin)
      return { ok: false, moved: true };
    const el = marked();
    const top = topAt(opts.x ?? 0, opts.y ?? 0);
    const labelFor = top instanceof HTMLLabelElement && top.control === el;
    return { ok: el !== null && top !== null && (el.contains(top) || labelFor) };
  }

  if (opts.op === "consent") {
    for (const old of h.findAll('[data-hearth="C1"]')) old.removeAttribute("data-hearth");
    const reject = new RegExp(opts.reject ?? "reject", "i");
    const buttons = h.findAll(
      'button, [role="button"], a, input[type="button"], input[type="submit"]',
    );
    const shown = (/** @type {Element} */ b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== "hidden";
    };
    const banner = buttons.filter((b) => h.inConsent(b) && shown(b));
    if (banner.length === 0) return { found: false, banner: false };
    const button = banner.find((b) => reject.test(h.labelOf(b)));
    if (!button)
      return { found: false, banner: true, buttons: banner.slice(0, 12).map((b) => h.labelOf(b)) };
    button.setAttribute("data-hearth", "C1");
    button.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = topAt(x, y);
    return {
      found: true,
      banner: true,
      label: h.labelOf(button),
      // A "reject" that would pay, or send a password, is no cookie banner's.
      floor: h.classify(button, "click").floor,
      x,
      y,
      covered: top === null || !button.contains(top),
    };
  }

  const el = marked();
  const owner = /** @type {{ form?: HTMLFormElement | null } | null} */ (el);
  const form = el ? (owner?.form ?? el.closest("form")) : null;
  const fields = (form ? [...form.querySelectorAll("*")] : h.findAll("*")).filter((f) => {
    const kind = h.kindOf(f);
    if (!kind || !/field|text area|select|checkbox|radio/.test(kind)) return false;
    if (kind === "password field" || kind === "file field" || h.isCard(f)) return false;
    const r = f.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  /** @param {Element} f */
  const shownValue = (f) => {
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
      value: shownValue(f).replace(/\s+/g, " ").trim().slice(0, 300),
    })),
  };
}
