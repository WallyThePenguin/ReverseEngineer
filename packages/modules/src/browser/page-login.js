// @ts-check
// Runs inside a web page, for signing in from the vault (D26): finds the sign-in form's fields,
// puts the cursor in one so Chrome can type into it, and afterwards says what the page wants
// next (a code, a captcha, the password again). It never reads what's typed. One self-contained
// function, sent as source; `h` is page-elements.js.

/**
 * @param {{ op: "find" | "focus" | "state", which?: "user" | "pass", marker?: string,
 *   host?: string }} opts
 * @param {PageElements} h
 */
// biome-ignore lint/correctness/noUnusedVariables: sent to the page as source text.
function pageLogin(opts, h) {
  const USERISH = /user|email|e-mail|login|account|identifier|phone/i;
  const CODEISH =
    /otp|one.?time|2fa|two.?factor|verification|security.?code|totp|passcode|authenticator|\bcode\b/i;
  const CAPTCHA_FRAMES =
    /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha/i;

  /** @param {Element} el */
  function visible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && Number(s.opacity) > 0;
  }

  /** @param {Element} el */
  function describes(el) {
    return [
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      h.labelOf(el),
    ].join(" ");
  }

  const inputs = /** @type {HTMLInputElement[]} */ (h.findAll("input")).filter(
    (i) => visible(i) && !i.disabled,
  );
  const passwords = inputs.filter((i) => i.type === "password");
  const textual = inputs.filter((i) => ["text", "email", "tel", ""].includes(i.type));
  const codeField = textual.find(
    (i) => i.autocomplete === "one-time-code" || CODEISH.test(describes(i)),
  );
  const frames = h
    .findAll("iframe")
    .filter((f) => CAPTCHA_FRAMES.test(f.getAttribute("src") ?? ""));
  const text = (document.body?.innerText ?? "").slice(0, 5000);
  const captcha = frames.some(visible) || /verify you are (a )?human|i'?m not a robot/i.test(text);

  if (opts.op === "focus") {
    // Checked in the same step as focusing: the page can't move on in between.
    if (location.protocol !== "https:" || location.hostname !== opts.host)
      return { focused: false };
    const [el] = h.findAll(`[data-hearth-login="${opts.marker}-${opts.which}"]`);
    if (!(el instanceof HTMLInputElement) || !el.isConnected) return { focused: false };
    // The password goes into a password field and nowhere else.
    if (opts.which === "pass" && el.type !== "password") return { focused: false };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    el.select();
    const root = /** @type {Document | ShadowRoot} */ (el.getRootNode());
    return { focused: root.activeElement === el };
  }

  if (opts.op === "state") {
    return { pass: passwords.length > 0, code: Boolean(codeField) && !passwords.length, captcha };
  }

  for (const el of h.findAll("[data-hearth-login]")) el.removeAttribute("data-hearth-login");
  const pass = passwords[0] ?? null;
  /** @type {HTMLInputElement | null} */
  let user = null;
  if (pass) {
    // The name field is the last one before the password, in the same form if there is one.
    const scope = textual.filter((i) => !pass.form || i.form === pass.form);
    const before = scope.filter(
      (i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    user =
      before.find((i) => i.autocomplete === "username") ??
      before.filter((i) => i !== codeField).at(-1) ??
      null;
  } else if (!codeField) {
    // A name on its own is filled only on what's plainly a sign-in page, never in a box for
    // sharing or inviting by email.
    const signInPage = /log.?in|sign.?in|auth|session|account|sso/i.test(location.pathname);
    user =
      textual.find((i) => i.autocomplete === "username") ??
      (signInPage ? textual.find((i) => USERISH.test(describes(i))) : undefined) ??
      null;
  }
  // A fresh marker each time, which the page can't know in advance.
  user?.setAttribute("data-hearth-login", `${opts.marker}-user`);
  pass?.setAttribute("data-hearth-login", `${opts.marker}-pass`);
  return {
    user: user !== null,
    pass: pass !== null,
    code: Boolean(codeField) && !pass,
    captcha,
  };
}
