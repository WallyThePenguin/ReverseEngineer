// @ts-check
// Runs inside a web page: small checks the browser's hands make around a step. "active" says
// what has the keyboard's focus, "hit" whether a click at a point would still land on the
// element meant, and "form" what a submit would send (each field's name and what's in it), so
// the approval card can show it and the press can be refused if it changed. One self-contained
// function, sent as source; `h` is page-elements.js.

/**
 * @param {{ op: "active" | "hit" | "form", ref?: string, x?: number, y?: number }} opts
 * @param {PageElements} h
 */
// biome-ignore lint/correctness/noUnusedVariables: sent to the page as source text.
function pageProbe(opts, h) {
  const marked = () =>
    opts.ref && /^E\d+$/.test(opts.ref)
      ? (h.findAll(`[data-hearth="${opts.ref}"]`)[0] ?? null)
      : null;

  if (opts.op === "active") {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    if (!a || a === document.body || a === document.documentElement) return { kind: null };
    return { kind: h.kindOf(a), label: h.labelOf(a), submits: h.submits(a) };
  }

  if (opts.op === "hit") {
    const el = marked();
    let top = document.elementFromPoint(opts.x ?? 0, opts.y ?? 0);
    while (top?.shadowRoot) {
      const inner = top.shadowRoot.elementFromPoint(opts.x ?? 0, opts.y ?? 0);
      if (!inner || inner === top) break;
      top = inner;
    }
    const labelFor = top instanceof HTMLLabelElement && top.control === el;
    return { ok: el !== null && top !== null && (el.contains(top) || labelFor) };
  }

  const el = marked();
  const owner = /** @type {{ form?: HTMLFormElement | null } | null} */ (el);
  const form = el ? (owner?.form ?? el.closest("form")) : null;
  const fields = (form ? [...form.querySelectorAll("*")] : h.findAll("*")).filter((f) => {
    const kind = h.kindOf(f);
    if (!kind || !/field|text area|select|checkbox|radio/.test(kind)) return false;
    if (kind === "password field" || kind === "file field") return false;
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
