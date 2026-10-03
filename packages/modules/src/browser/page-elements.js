// @ts-check
// Runs inside a web page, like page-snapshot.js: what Hearth needs to know about the things a
// person can click or type into. The page reader numbers them ("E4") and the browser's hands use
// the same rules to decide whether pressing one sends something, which needs your yes. This file
// is sent to Chrome as source, so it must stay one self-contained function with no imports.

/** @returns {PageElements} */
// biome-ignore lint/correctness/noUnusedVariables: sent to the page as source text.
function pageElements() {
  const ROLES = new Map([
    ["button", "button"],
    ["link", "button"],
    ["tab", "tab"],
    ["menuitem", "menu item"],
    ["menuitemcheckbox", "checkbox"],
    ["menuitemradio", "radio"],
    ["option", "option"],
    ["checkbox", "checkbox"],
    ["switch", "checkbox"],
    ["radio", "radio"],
    ["combobox", "field"],
    ["textbox", "field"],
    ["searchbox", "field"],
  ]);
  // Pressing something with one of these words in its name sends, buys, posts or deletes.
  const OUTWARD =
    /\b(send|submit|post|publish|buy|purchase|pay|order|checkout|check out|confirm|place|book|reserve|subscribe|sign up|register|apply|donate|transfer|delete|remove|reply|comment|tweet|share|invite|accept|decline|like|follow|unfollow|connect|vote|upvote|repost|retweet|message|save)\b/i;
  const SEARCH_NAMES = /^(q|query|search|s|k|keywords?|term|search_query)$/i;
  const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

  /** @param {string | null | undefined} s */
  function clean(s) {
    return (s ?? "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  /** @param {Element} el @returns {string | null} */
  function kindOf(el) {
    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return null;
      if (type === "password") return "password field";
      if (type === "checkbox" || type === "radio") return type;
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "file") return "file field";
      return "field";
    }
    if (tag === "TEXTAREA") return "text area";
    if (tag === "SELECT") return "select";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    const role = (el.getAttribute("role") ?? "").toLowerCase();
    if (ROLES.has(role)) return ROLES.get(role) ?? null;
    const editable = el.getAttribute("contenteditable");
    if (editable === "" || editable === "true" || editable === "plaintext-only") return "text area";
    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      // Links to pages are opened by address ("L4"); the rest run scripts, like buttons.
      if (!/^https?:/i.test(/** @type {HTMLAnchorElement} */ (el).href) || href.startsWith("#"))
        return el.hasAttribute("href") || el.hasAttribute("onclick") ? "button" : null;
      return null;
    }
    return el.hasAttribute("onclick") ? "button" : null;
  }

  /** @param {Element} el */
  function fieldLabel(el) {
    const id = el.getAttribute("id");
    const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrap = el.closest("label");
    let wrapped = "";
    if (wrap) {
      const copy = /** @type {Element} */ (wrap.cloneNode(true));
      for (const f of copy.querySelectorAll("input, select, textarea")) f.remove();
      wrapped = copy.textContent ?? "";
    }
    return clean(
      el.getAttribute("aria-label") ||
        forLabel?.textContent ||
        wrapped ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("name") ||
        "",
    );
  }

  /** @param {Element} el */
  function labelOf(el) {
    const kind = kindOf(el);
    if (kind && /field|text area|select|checkbox|radio/.test(kind) && el.tagName !== "BUTTON")
      return fieldLabel(el);
    const img = el.querySelector("img[alt]");
    return clean(
      el.getAttribute("aria-label") ||
        (el instanceof HTMLElement ? el.innerText : el.textContent) ||
        el.getAttribute("value") ||
        el.getAttribute("title") ||
        img?.getAttribute("alt") ||
        "",
    );
  }

  /** @param {HTMLFormElement} form */
  function isSearchForm(form) {
    if ((form.getAttribute("method") ?? "get").toLowerCase() !== "get") return false;
    if (form.querySelector('input[type="password"]')) return false;
    return (
      form.getAttribute("role") === "search" ||
      form.closest('[role="search"]') !== null ||
      form.querySelector('input[type="search"]') !== null ||
      /search|find|query/i.test(form.getAttribute("action") ?? "") ||
      [...form.elements].some((e) => SEARCH_NAMES.test(e.getAttribute("name") ?? ""))
    );
  }

  /** @param {Element} el @returns {HTMLFormElement | null} */
  function formOf(el) {
    const own = /** @type {any} */ (el).form;
    return own instanceof HTMLFormElement ? own : el.closest("form");
  }

  /** Whether pressing it (or pressing Enter in it) would send something somewhere. @param {Element} el */
  function submits(el) {
    const tag = el.tagName.toUpperCase();
    const kind = kindOf(el);
    // Ticking a box, picking from a list or writing in a text area sends nothing by itself.
    if (kind && ["checkbox", "radio", "select", "text area", "file field"].includes(kind))
      return false;
    if (kind === "field" || kind === "password field") {
      const form = formOf(el);
      return form === null || !isSearchForm(form);
    }
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    const form = formOf(el);
    const native =
      (tag === "BUTTON" && (type === "" || type === "submit") && form !== null) ||
      (tag === "INPUT" && (type === "submit" || type === "image"));
    if (native && form && !isSearchForm(form)) return true;
    return OUTWARD.test(labelOf(el));
  }

  /** @param {Element} el */
  function stateOf(el) {
    const kind = kindOf(el);
    const parts = [];
    if (kind === "checkbox" || kind === "radio") {
      const on =
        el instanceof HTMLInputElement
          ? el.checked
          : el.getAttribute("aria-checked") === "true" ||
            el.getAttribute("aria-selected") === "true";
      parts.push(kind === "radio" ? (on ? "chosen" : "not chosen") : on ? "checked" : "unchecked");
    }
    if (el instanceof HTMLSelectElement) parts.push(`= ${clean(el.selectedOptions[0]?.text)}`);
    if (/** @type {any} */ (el).disabled || el.getAttribute("aria-disabled") === "true")
      parts.push("disabled");
    return parts.join(", ");
  }

  /** Every element matching a selector, inside open shadow roots too. @param {string} selector */
  function findAll(selector) {
    /** @type {Element[]} */
    const out = [];
    /** @param {Document | ShadowRoot} root */
    const visit = (root) => {
      out.push(...root.querySelectorAll(selector));
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document);
    return out;
  }

  return { kindOf, labelOf, submits, stateOf, clean, findAll };
}

/**
 * @typedef {{
 *   kindOf(el: Element): string | null,
 *   labelOf(el: Element): string,
 *   submits(el: Element): boolean,
 *   stateOf(el: Element): string,
 *   clean(s: string | null | undefined): string,
 *   findAll(selector: string): Element[],
 * }} PageElements
 */
