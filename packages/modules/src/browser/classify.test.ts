import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromiumForTests, chromiumPath } from "./chromium.ts";
import { askWhy, dialogVerdict, FREE, judge, type Verdict } from "./classify.ts";
import { pageCall } from "./page.ts";

const sends = (floor: Verdict["floor"] = null): Verdict => ({ sends: true, floor, why: "x" });

describe("whether a press may go ahead (D52)", () => {
  it.each([
    ["nothing sent, anywhere", FREE, false, "go"],
    ["nothing sent, trusted", FREE, true, "go"],
    ["sends, untrusted", sends(), false, "ask"],
    ["sends, trusted", sends(), true, "go"],
    ["payment, trusted", sends("payment"), true, "ask"],
    ["money, trusted", sends("money"), true, "ask"],
    ["password, trusted", sends("password"), true, "ask"],
    ["security, trusted", sends("security"), true, "ask"],
    ["account deletion, trusted", sends("account"), true, "ask"],
    ["payment, untrusted", sends("payment"), false, "ask"],
  ] as const)("%s", (_name, verdict, trusted, expected) => {
    expect(judge(verdict, trusted)).toBe(expected);
  });

  it("says why it asks, and what to do instead", () => {
    expect(
      askWhy('Pressing "Save"', { ...sends(), why: "send a form (it posts)" }, false, "Use X."),
    ).toBe(
      'Pressing "Save" would send a form (it posts). Use X. On a site the owner trusts, it wouldn\'t need to ask.',
    );
    expect(askWhy('Pressing "Pay"', sends("payment"), true, "Use X.")).toMatch(
      /pays or places an order, which always needs the owner's yes, even on a trusted site/,
    );
  });

  it.each([
    [{ type: "alert", message: "Delete everything?" }, false, null],
    [{ type: "beforeunload", message: "" }, false, null],
    [{ type: "prompt", message: "Your name?" }, false, null],
    [{ type: "confirm", message: "Are you sure you want to leave?" }, false, null],
    [{ type: "confirm", message: "Delete this note?" }, true, null],
    [{ type: "confirm", message: "Transfer $500 to Sam?" }, true, "money"],
    [{ type: "confirm", message: "Close your account for good?" }, true, "account"],
  ])("accepting %j sends: %s, floor: %s", (dialog, sendsIt, floor) => {
    const v = dialogVerdict(dialog);
    expect(v.sends).toBe(sendsIt);
    expect(v.floor).toBe(floor);
  });
});

// The page side, in a real page (HEARTH_SKIP_BROWSER_TESTS=1 skips).
const hasChromium = chromiumForTests();
let browser: Browser;
beforeAll(async () => {
  if (hasChromium) browser = await chromium.launch({ executablePath: chromiumPath()! });
});
afterAll(async () => {
  await browser?.close();
});

const PAGE = `<!doctype html><title>Shop</title>
  <form role="search" action="/search"><input name="q" data-case="search-enter" data-how="enter"><button data-case="search-button">Go</button></form>
  <form method="post" action="/profile"><input name="nick" data-case="post-enter" data-how="enter"><button data-case="post-save">Save</button>
    <input type="checkbox" data-case="post-checkbox"></form>
  <form method="post" action="/login"><input name="user"><input type="password" name="pw"><button data-case="login">Sign in</button></form>
  <form method="post" action="/pay"><input autocomplete="cc-number" data-case="card-field" data-how="enter"><button data-case="pay">Continue</button></form>
  <form action="https://elsewhere.example/collect"><input name="email" data-case="cross-site" data-how="enter"></form>
  <form><input name="name"><button data-case="scripted-next">Next</button></form>
  <form><input name="body"><button data-case="scripted-send">Send</button></form>
  <form><input name="lonely" data-case="scripted-no-button" data-how="enter"></form>
  <button data-case="delete">Delete</button>
  <button data-case="pay-now">Pay now</button>
  <button data-case="delete-account">Delete my account</button>
  <button data-case="send-money">Send money</button>
  <button data-case="accept">Accept</button>
  <button data-case="continue">Continue</button>
  <div id="cookie-consent"><button data-case="cookie-accept">Accept all</button><button data-case="cookie-post">Post my choices</button></div>
  <textarea data-case="textarea-enter" data-how="enter"></textarea>
  <textarea data-case="textarea-click"></textarea>
  <div contenteditable="true" data-case="editable-enter" data-how="enter"></div>
  <label><input type="checkbox" role="switch" data-case="switch"> Dark mode</label>
  <label><input type="checkbox" data-case="loose-publish"> Publish my profile</label>
  <input type="search" data-case="loose-search" data-how="enter">
  <input name="note" data-case="loose-field" data-how="enter">
  <a role="tab" href="https://shop.example/t2" data-case="tab-anchor">Details</a>
  <button data-case="close-account">Close my account</button>
  <button data-case="order-now">Order now</button>
  <button data-case="make-payment">Make a payment</button>
  <button data-case="submit-order">Submit order</button>
  <button data-case="confirm-order">Confirm order</button>
  <button data-case="two-factor">Turn off two-factor authentication</button>
  <div role="tab" data-case="passwords-tab">Passwords</div>
  <div role="dialog"><p>I consent to being contacted about this.</p>
    <form method="post" action="/lead"><input name="email"><button data-case="consent-lead">Get the guide</button></form></div>
  <div class="gdpr-consent-signup"><form method="post" action="/news"><input name="email" aria-label="Email"><button data-case="consent-signup">Sign up</button></form></div>
  <form action="https://elsewhere.example/c"><input name="action"><input name="note2" data-case="clobbered-action" data-how="enter"></form>`;

const EXPECTED: Record<string, [boolean, string | null]> = {
  "search-enter": [false, null],
  "search-button": [false, null],
  "post-enter": [true, null],
  "post-save": [true, null],
  "post-checkbox": [false, null],
  login: [true, "password"],
  "card-field": [true, "payment"],
  pay: [true, "payment"],
  "cross-site": [true, null],
  "scripted-next": [false, null],
  "scripted-send": [true, null],
  "scripted-no-button": [true, null],
  delete: [true, null],
  "pay-now": [true, "money"],
  "delete-account": [true, "account"],
  "send-money": [true, "money"],
  accept: [false, null],
  continue: [false, null],
  "cookie-accept": [false, null],
  "cookie-post": [false, null],
  "textarea-enter": [true, null],
  "textarea-click": [false, null],
  "editable-enter": [true, null],
  switch: [true, null],
  "loose-publish": [true, null],
  "loose-search": [false, null],
  "loose-field": [true, null],
  "tab-anchor": [false, null],
  // The floor's own words send, even with no form and none of the verbs.
  "close-account": [true, "account"],
  "order-now": [true, "payment"],
  "make-payment": [true, "money"],
  "submit-order": [true, "payment"],
  "confirm-order": [true, "payment"],
  "two-factor": [true, "security"],
  // A tab only shows another part of the page.
  "passwords-tab": [false, null],
  // A form you type into isn't a cookie banner, whatever its box says about consent.
  "consent-lead": [true, null],
  "consent-signup": [true, null],
  // A field named "action" can't hide where a form sends.
  "clobbered-action": [true, null],
};

async function verdicts(
  path: string,
  html = PAGE,
): Promise<Record<string, [boolean, string | null]>> {
  const page = await browser.newPage();
  await page.route("https://shop.example/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(`https://shop.example${path}`);
  const each = `(opts, h) => Object.fromEntries([...document.querySelectorAll("[data-case]")].map((el) => {
    const v = h.classify(el, el.dataset.how || "click");
    return [el.dataset.case, [v.sends, v.floor]];
  }))`;
  const out = (await page.evaluate(pageCall(each, {}))) as Record<string, [boolean, string | null]>;
  await page.close();
  return out;
}

describe.skipIf(!hasChromium)("what sends, judged on the page (D52)", () => {
  it("looks at structure first, then a few words, and knows the floor", async () => {
    expect(await verdicts("/")).toEqual(EXPECTED);
  });

  it("doesn't take a whole page for a cookie banner because its <body> mentions one", async () => {
    const page = `<!doctype html><title>Notes</title><body class="has-cookie-banner">
      <button data-case="delete">Delete</button>`;
    expect(await verdicts("/", page)).toEqual({ delete: [true, null] });
  });

  it("asks about every change on a security settings page", async () => {
    const onSecurity = await verdicts("/settings/security");
    expect(onSecurity.continue).toEqual([true, "security"]);
    expect(onSecurity["tab-anchor"]).toEqual([false, null]);
  });
});
