// @ts-check
// Runs inside a web page, like page-snapshot.js: what Hearth needs to know about the things a
// person can click or type into. The page reader numbers them ("E4") and the browser's hands use
// the same test to decide whether pressing one sends something (D52): the page's structure first
// (a form that posts, payment or password fields, a form that sends to another site), then a few
// words in its name. The words come from classify.ts as `rules`. This file is sent to Chrome as
// source, so it must stay one self-contained function with no imports.

/**
 * @param {PageRules} rules
 * @returns {PageElements}
 */
// biome-ignore lint/correctness/noUnusedVariables: sent to the page as source text.
function pageElements(rules) {
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
  const re = (/** @type {string} */ source) => new RegExp(source, "i");
  const VERBS = re(rules.verbs);
  const PAYMENT = re(rules.payment);
  const MONEY = re(rules.money);
  const ACCOUNT = re(rules.account);
  const SECURITY = re(rules.security);
  const SECURITY_PATH = re(rules.securityPath);
  const CARD = re(rules.card);
  const PAYMENT_FRAMES = re(rules.paymentFrames);
  const CONSENT = re(rules.consent);
  const SEARCH_NAMES = /^(q|query|search|s|k|keywords?|term|search_query)$/i;
  const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;
  /** @type {Verdict} */
  const FREE = { sends: false, floor: null, why: "" };

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
    // A real link to a page is opened by its address ("L4"), even with role="link".
    if (tag === "A" && (role === "" || role === "link") && pageLink(el)) return null;
    if (ROLES.has(role)) return ROLES.get(role) ?? null;
    const editable = el.getAttribute("contenteditable");
    if (editable === "" || editable === "true" || editable === "plaintext-only") return "text area";
    // The rest of the links run scripts, like buttons.
    if (tag === "A") return el.hasAttribute("href") || el.hasAttribute("onclick") ? "button" : null;
    return el.hasAttribute("onclick") ? "button" : null;
  }

  /** A link to another page (not "#top" or a script). @param {Element} el */
  function pageLink(el) {
    const href = el.getAttribute("href") ?? "";
    return /^https?:/i.test(/** @type {HTMLAnchorElement} */ (el).href) && !href.startsWith("#");
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

  /** A search box outside any form. @param {Element} el */
  function isSearchField(el) {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    return (
      type === "search" ||
      el.getAttribute("role") === "searchbox" ||
      el.closest('[role="search"]') !== null ||
      SEARCH_NAMES.test(el.getAttribute("name") ?? "") ||
      /search/i.test(
        `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("placeholder") ?? ""}`,
      )
    );
  }

  /** @param {Element} el @returns {HTMLFormElement | null} */
  function formOf(el) {
    const own = /** @type {any} */ (el).form;
    return own instanceof HTMLFormElement ? own : el.closest("form");
  }

  /** An embedded frame or object, whose inside Hearth can't see. @param {Element} el */
  const isFrame = (el) => /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(el.tagName.toUpperCase());

  /** A field for card or bank details, or a payment provider's frame holding them. @param {Element} el */
  function isCard(el) {
    if (isFrame(el))
      return PAYMENT_FRAMES.test(
        `${el.getAttribute("src") ?? ""} ${el.getAttribute("data") ?? ""}`,
      );
    if (!(el instanceof HTMLInputElement)) return false;
    if (/^cc-/i.test(el.getAttribute("autocomplete") ?? "")) return true;
    const names = ["name", "id", "aria-label", "placeholder"].map((a) => el.getAttribute(a) ?? "");
    return CARD.test(names.join(" ").replace(/[_-]+/g, " ")) || CARD.test(fieldLabel(el));
  }

  /** @param {ParentNode} scope */
  function hasPayment(scope) {
    for (const f of scope.querySelectorAll("input, iframe")) if (isCard(f)) return true;
    return false;
  }

  /** @param {ParentNode} scope */
  const hasPassword = (scope) => scope.querySelector('input[type="password"]') !== null;

  /** Somewhere to type, which a cookie banner never has. @param {ParentNode} scope */
  const hasTyping = (scope) =>
    scope.querySelector(
      'textarea, [contenteditable=""], [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
    ) !== null;

  /**
   * Inside a cookie or consent banner: buttons and switches, named for cookies or consent, and
   * nowhere to type. A sign-up or contact form that mentions consent is still a form, and the
   * page's own <body> or <html> saying a banner is showing doesn't make the whole page one.
   * @param {Element} el
   */
  function inConsent(el) {
    const form = formOf(el);
    if (form && hasTyping(form)) return false;
    for (let a = /** @type {Element | null} */ (el); a; a = a.parentElement) {
      if (a === document.body || a === document.documentElement) break;
      const names = `${a.id} ${a.getAttribute("class") ?? ""} ${a.getAttribute("aria-label") ?? ""}`;
      if (CONSENT.test(names)) return !hasTyping(a);
      if (a.tagName === "FORM" && CONSENT.test(a.getAttribute("action") ?? ""))
        return !hasTyping(a);
      const role = a.getAttribute("role");
      if (
        (role === "dialog" || role === "alertdialog" || a.tagName === "DIALOG") &&
        a instanceof HTMLElement
      )
        return /\bcookies?\b|consent/i.test(a.innerText.slice(0, 3000)) && !hasTyping(a);
    }
    return false;
  }

  /** On a password or security settings page, where every press that changes something asks. */
  function onSecurityPage() {
    return SECURITY_PATH.test(location.pathname);
  }

  /**
   * Whether submitting a form sends something somewhere. A GET form on the same site (a search, a
   * filter) doesn't, unless it has password or payment fields. A form with neither a method nor an
   * action is sent by the page's scripts, often as a post, so its button's name decides.
   * @param {HTMLFormElement} form
   * @param {Element | null} submitter
   * @returns {Verdict}
   */
  function formSends(form, submitter) {
    if (hasPassword(form))
      return { sends: true, floor: "password", why: "send a form with a password" };
    if (hasPayment(form)) return { sends: true, floor: "payment", why: "send payment details" };
    const method = (
      submitter?.getAttribute("formmethod") ||
      form.getAttribute("method") ||
      "get"
    ).toLowerCase();
    if (method === "dialog") return FREE;
    if (method !== "get") return { sends: true, floor: null, why: "send a form (it posts)" };
    // From the attributes: a field named "action" would stand in for form.action.
    const action =
      submitter?.getAttribute("formaction") || form.getAttribute("action") || location.href;
    let origin = "";
    try {
      origin = new URL(action, document.baseURI).origin;
    } catch {}
    if (origin && origin !== location.origin)
      return { sends: true, floor: null, why: "send a form to another site" };
    const scripted =
      !form.hasAttribute("method") &&
      !form.hasAttribute("action") &&
      !submitter?.hasAttribute("formaction");
    if (!scripted || isSearchForm(form)) return FREE;
    const button =
      submitter ??
      form.querySelector('button:not([type]), button[type="submit"], input[type="submit"]');
    if (!button) return { sends: true, floor: null, why: "send a form the page handles itself" };
    return byName(labelOf(button), kindOf(button));
  }

  /**
   * By the words in its name: one of the few verbs, or the floor's own words ("Close my account",
   * "Make a payment"), which send whatever else is true. A tab or an option only shows another
   * part of the page, so a "Passwords" tab is just a tab.
   * @param {string} label
   * @param {string | null} kind
   * @returns {Verdict}
   */
  function byName(label, kind) {
    const verb = VERBS.exec(label);
    if (verb)
      return {
        sends: true,
        floor: null,
        why: `do what its name says ("${verb[0].toLowerCase()}")`,
      };
    const floor = kind === "tab" || kind === "option" ? null : namedFloor(label);
    return floor ? { sends: true, floor, why: "do what its name says" } : FREE;
  }

  /** The floor a name hits. @param {string} label @returns {Verdict["floor"]} */
  function namedFloor(label) {
    if (MONEY.test(label)) return "money";
    if (PAYMENT.test(label)) return "payment";
    if (ACCOUNT.test(label)) return "account";
    if (SECURITY.test(label)) return "security";
    return null;
  }

  /** @param {string} label @param {Element} el @param {HTMLFormElement | null} form @returns {Verdict["floor"]} */
  function floorOf(label, el, form) {
    const named = namedFloor(label);
    if (named) return named;
    if (onSecurityPage()) return "security";
    if (isCard(el) || (form && hasPayment(form))) return "payment";
    if (el.getAttribute("type") === "password" || (form && hasPassword(form))) return "password";
    return null;
  }

  /**
   * What pressing it would do: a click (or Space), or Enter in it. `asButton`: something the page
   * made clickable on its own (a <div> with a click handler), judged by its name as a button is.
   * @param {Element} el
   * @param {"click" | "enter"} how
   * @returns {Verdict}
   */
  function classify(el, how, asButton = false) {
    // Focus inside an embedded frame (a payment form, a comment box from another site): what a
    // key does there can't be seen from here, so it counts as sending.
    if (isFrame(el))
      return {
        sends: true,
        floor: isCard(el) ? "payment" : null,
        why: "press something inside an embedded frame Hearth can't see into",
      };
    const kind = kindOf(el);
    const form = formOf(el);
    const label = labelOf(el);
    const typing = kind === "field" || kind === "password field";
    /** @type {Verdict} */
    let v = FREE;
    if (how === "enter" && kind === "text area")
      v = { sends: true, floor: null, why: "send it (Enter sends in most chat and comment boxes)" };
    else if (how === "enter" && typing) {
      if (form) v = formSends(form, null);
      else if (!isSearchField(el)) v = { sends: true, floor: null, why: "send what's in it" };
    } else if (kind === "checkbox" || kind === "radio" || kind === "select") {
      // Ticking a box in a form waits for the form. A switch, or one outside any form, may
      // change something at once ("Make profile public").
      if (el.getAttribute("role") === "switch" || el.closest('[role="switch"]'))
        v = { sends: true, floor: null, why: "change a setting at once (it's a switch)" };
      else if (!form) v = byName(label, kind);
    } else if (!typing && kind !== "text area" && kind !== "file field" && (kind || asButton)) {
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      const tag = el.tagName.toUpperCase();
      const native =
        (tag === "BUTTON" && (type === "" || type === "submit")) ||
        (tag === "INPUT" && (type === "submit" || type === "image"));
      if (native && form) v = formSends(form, el);
      if (!v.sends) v = byName(label, kind);
      if (!v.sends && onSecurityPage() && kind !== "tab" && kind !== "option")
        v = { sends: true, floor: "security", why: "change security settings" };
    }
    if (!v.sends) return FREE;
    const floor = v.floor ?? floorOf(label, el, form);
    // A cookie banner's buttons never count as sending (unless they hit the floor).
    if (!floor && inConsent(el)) return FREE;
    return { sends: true, floor, why: v.why };
  }

  /** Whether pressing it (Enter in a field) would send something somewhere. @param {Element} el */
  function submits(el) {
    const kind = kindOf(el);
    return classify(el, kind === "field" || kind === "password field" ? "enter" : "click").sends;
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

  return { kindOf, labelOf, classify, submits, isCard, inConsent, stateOf, clean, findAll };
}

/**
 * @typedef {{ verbs: string, payment: string, money: string, account: string, security: string,
 *   securityPath: string, card: string, paymentFrames: string, consent: string, reject: string }} PageRules
 * @typedef {{ sends: boolean, floor: "payment" | "money" | "account" | "security" | "password" | null,
 *   why: string }} Verdict
 * @typedef {{
 *   kindOf(el: Element): string | null,
 *   labelOf(el: Element): string,
 *   classify(el: Element, how: "click" | "enter", asButton?: boolean): Verdict,
 *   submits(el: Element): boolean,
 *   isCard(el: Element): boolean,
 *   inConsent(el: Element): boolean,
 *   stateOf(el: Element): string,
 *   clean(s: string | null | undefined): string,
 *   findAll(selector: string): Element[],
 * }} PageElements
 */
