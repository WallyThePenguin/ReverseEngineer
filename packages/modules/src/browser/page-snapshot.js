// @ts-check
// Runs inside a web page, in an isolated world the page's own scripts can't see, and turns what a
// person would see into text Jarvis can read: headings, paragraphs, lists, fields, and links as
// numbered references ("Pricing [L4]"). Text a person can't see is left out, since hidden text is
// a favourite place for instructions aimed at AI readers. This file is sent to Chrome as source,
// so it must stay one self-contained function with no imports.

/**
 * @param {{ maxChars: number, selector?: string }} opts
 * @returns {{ url: string, title: string, text: string, links: string[], truncated: boolean,
 *   missing: boolean }}
 */
// biome-ignore lint/correctness/noUnusedVariables: sent to the page as source text.
function pageSnapshot(opts) {
  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "HEAD",
    "META",
    "LINK",
    "SVG",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "VIDEO",
    "AUDIO",
    "MAP",
  ]);
  const BLOCK = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DD",
    "DETAILS",
    "DIALOG",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "SUMMARY",
    "TABLE",
    "TBODY",
    "THEAD",
    "TFOOT",
    "TR",
    "UL",
  ]);
  // Zero-width characters, bidi overrides and Unicode "tag" characters can hide text in plain sight.
  const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

  /** @type {string[]} */
  const parts = [];
  /** @type {string[]} */
  const links = [];
  /** @type {Map<string, number>} */
  const linkRefs = new Map();
  let size = 0;
  let full = false;

  /** @param {string} s */
  function push(s) {
    if (full || !s) return;
    if (size + s.length > opts.maxChars) {
      parts.push(s.slice(0, Math.max(0, opts.maxChars - size)));
      full = true;
      return;
    }
    parts.push(s);
    size += s.length;
  }
  function breakLine() {
    const last = parts[parts.length - 1];
    if (last !== undefined && !last.endsWith("\n")) push("\n");
  }
  /** @param {string | null | undefined} s */
  function clean(s) {
    return (s ?? "").replace(INVISIBLE, "").replace(/\s+/g, " ");
  }

  /** @param {Element} el */
  function hidden(el) {
    if (el instanceof HTMLElement && el.hidden) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse")
      return true;
    if (Number(s.opacity) === 0) return true;
    if (s.display === "contents") return false;
    if (parseFloat(s.fontSize) < 4) return true;
    const r = el.getBoundingClientRect();
    const clipped = s.overflowX !== "visible" || s.overflowY !== "visible";
    // Screen-reader-only text and collapsed boxes: a pixel or less, with the rest cut off.
    if (clipped && (r.width <= 1 || r.height <= 1)) return true;
    if (s.clipPath === "inset(50%)" || s.clip === "rect(0px, 0px, 0px, 0px)") return true;
    // Pushed off the left or top of the page, where nobody can scroll to it.
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return true;
    return false;
  }

  /** @param {HTMLAnchorElement} a */
  function linkRef(a) {
    const href = a.href;
    if (!/^https?:/i.test(href)) return null;
    let n = linkRefs.get(href);
    if (n === undefined) {
      links.push(href);
      n = links.length;
      linkRefs.set(href, n);
    }
    return `L${n}`;
  }

  /** @param {Element} el */
  function fieldLabel(el) {
    const id = el.getAttribute("id");
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    return clean(
      el.getAttribute("aria-label") ||
        label?.textContent ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        "",
    ).trim();
  }

  /** @param {Node} node @param {boolean} pre */
  function walk(node, pre) {
    if (full) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? "";
      push(pre ? raw.replace(INVISIBLE, "") : clean(raw));
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toUpperCase();
    if (SKIP.has(tag) || hidden(node)) return;

    if (tag === "BR") return breakLine();
    if (tag === "IMG") {
      const alt = clean(node.getAttribute("alt")).trim();
      if (alt && alt.length <= 150) push(`[image: ${alt}]`);
      return;
    }
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const type = (node.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return;
      // Never what's typed in it: that's yours, and it may be a password.
      if (type === "submit" || type === "button")
        push(` [button: ${clean(node.getAttribute("value")).trim() || "submit"}] `);
      else push(` [${type === "password" ? "password field" : "field"}: ${fieldLabel(node)}] `);
      return;
    }

    const heading = /^H([1-6])$/.exec(tag);
    const block = BLOCK.has(tag) || heading !== null;
    if (block) breakLine();
    if (heading) push(`${"#".repeat(Number(heading[1]))} `);
    if (tag === "LI") push("- ");
    if (tag === "TD" || tag === "TH") push(" | ");
    if (tag === "BUTTON") push(" [button: ");

    const isPre = pre || tag === "PRE";
    const ref = tag === "A" ? linkRef(/** @type {HTMLAnchorElement} */ (node)) : null;
    const before = size;
    for (const child of node.childNodes) walk(child, isPre);
    if (node.shadowRoot) for (const child of node.shadowRoot.childNodes) walk(child, isPre);
    if (ref) {
      if (size === before)
        push(clean(node.getAttribute("aria-label") || node.getAttribute("title") || "link"));
      push(` [${ref}]`);
    }
    if (tag === "BUTTON") push("] ");
    if (block) breakLine();
  }

  // A selector narrows the reading to one part of the page, like a price.
  const root = opts.selector
    ? document.querySelector(opts.selector)
    : (document.body ?? document.documentElement);
  if (root) walk(root, false);
  const text = parts
    .join("")
    .split("\n")
    .map((line) => line.replace(/ +/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
  return {
    url: location.href,
    title: clean(document.title).trim(),
    text,
    links,
    truncated: full,
    missing: root === null,
  };
}
