// What "sends" (D52): one test for clicks, keys and dialogs. The page side (page-elements.js)
// looks at the page's structure first: a form that posts, payment or password fields, a form that
// sends to another site. Only then come a few words in a control's name. Whether Jarvis may go
// ahead is decided here: what doesn't send is free, what does is free on a site you trust, and
// the floor (payments, passwords and security, moving money, deleting an account) always asks.
import { networkInterfaces } from "node:os";
import { onSiteList } from "@hearth/core";
import { type ActionContext, getSetting } from "@hearth/kernel";
import { isLoopbackHost } from "./pace.ts";
import { TEST_PAGE_PATH } from "./self-test.ts";

/** Words in a control's name that mean pressing it sends something. */
export const VERBS =
  /\b(send|submit|pay|buy|purchase|place (?:my |your |the )?order|post|publish|delete|transfer|withdraw|donate)\b/i;

/**
 * The floor: words that always ask, even on a trusted site. A control named with one of them
 * sends, whatever else is true of it ("Close my account" with no form around it).
 */
export const FLOOR = {
  payment:
    /\b(pay|buy|purchase|(?:place|confirm|submit|complete|finish) (?:my |your |the |this )?(?:order|purchase)|order now|donate)\b/i,
  money: /\b(send money|transfer|withdraw|wire|pay (?:now|out)|make (?:a )?payment)\b/i,
  account:
    /\b(?:delete|close|deactivate|terminate|cancel|remove) (?:my |your |this |the )?account\b/i,
  security:
    /\b(passwords?|passcode|two[- ]?factor|2fa|2-step|mfa|authenticator|passkeys?|security (?:key|question|settings?)|recovery (?:code|email|phone))\b/i,
};

/** Addresses of security settings pages, where anything that sends hits the floor. */
export const SECURITY_PATH =
  /\/(security|password|passwords|2fa|two-factor|mfa|signin-options|account-recovery)(\/|$)/i;

/** Names of fields that hold card or bank details, which Jarvis never types. */
export const CARD =
  /\b(card ?(?:number|no|num)|cc-?(?:num|number|csc|cvc|exp\w*)|cvv2?|cvc2?|csc|security code|expir(?:y|ation)(?: date)?|iban|routing number|sort code)\b/i;

/** Payment providers whose card fields come in their own frames. */
export const PAYMENT_FRAMES =
  /(js\.stripe\.com|braintree|adyen|paypal\.com|checkout\.com|squareup|klarna|affirm\.com|recurly|chargebee)/i;

/** Cookie and consent banners, by the names their makers give them. */
export const CONSENT =
  /(cookie|consent|gdpr|onetrust|didomi|usercentrics|cookiebot|truste|quantcast|osano|sp_message|cmp-|-cmp\b|privacy[-_ ]?(?:banner|notice|choices))/i;

/** A banner's "no thanks": reject all, necessary only. */
export const REJECT =
  /\b(reject|decline|refuse|deny|disagree)\b|\b(necessary|essential|required) (?:cookies )?only\b|\bonly (?:necessary|essential|required)\b|continue without accepting|use necessary cookies only/i;

/** The rules as text, for page-elements.js, which runs in the page and gets them as source. */
export const PAGE_RULES = {
  verbs: VERBS.source,
  payment: FLOOR.payment.source,
  money: FLOOR.money.source,
  account: FLOOR.account.source,
  security: FLOOR.security.source,
  securityPath: SECURITY_PATH.source,
  card: CARD.source,
  paymentFrames: PAYMENT_FRAMES.source,
  consent: CONSENT.source,
  reject: REJECT.source,
};

/** Which part of the floor a press hits. */
export type Floor = "payment" | "money" | "account" | "security" | "password";

/** What a press would do, as the page side judged it. */
export interface Verdict {
  sends: boolean;
  /** Set only when it sends. */
  floor: Floor | null;
  /** Why it sends, as the end of "Pressing X would…". */
  why: string;
}

export const FREE: Verdict = { sends: false, floor: null, why: "" };

/** Whether a press may go ahead without the owner: free, or sends on a trusted site above the floor. */
export function judge(v: Verdict, trusted: boolean): "go" | "ask" {
  if (!v.sends) return "go";
  if (v.floor) return "ask";
  return trusted ? "go" : "ask";
}

const FLOOR_WHY: Record<Floor, string> = {
  payment: "pays or places an order",
  money: "moves money",
  account: "deletes or closes an account",
  security: "changes passwords or security settings",
  password: "sends a password",
};

/** The sentence a refused press gets: why it needs the owner, and what to use instead. */
export function askWhy(what: string, v: Verdict, trusted: boolean, instead: string): string {
  if (v.floor)
    return `${what} ${FLOOR_WHY[v.floor]}, which always needs the owner's yes, even on a trusted site. ${instead}`;
  const tail = trusted ? "" : " On a site the owner trusts, it wouldn't need to ask.";
  return `${what} would ${v.why || "send something"}. ${instead}${tail}`;
}

/** Why Jarvis's hands stay off Hearth's own pages. */
export const HEARTH_PAGE =
  "That's Hearth's own page. Jarvis does what's there with its own actions (approvals, tasks, mail, chat, settings), never by working the page; reading, scrolling and closing a dialog are fine. Anything to press there is the owner's to press.";

/** A host as compared: no brackets or trailing dot, and an IPv4 address written as IPv6
 * (::ffff:7f00:1) as itself. */
function bare(host: string): string {
  const h = host
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const v4 = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);
  if (!v4) return h;
  if (v4[1]) return v4[1];
  const [hi, lo] = [Number.parseInt(v4[2]!, 16), Number.parseInt(v4[3]!, 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** An address's host, port and path; a blob: address is its page's. Null if it isn't one. */
function hostOf(raw: string | undefined) {
  try {
    let u = new URL(raw ?? "");
    if (u.protocol === "blob:") u = new URL(u.pathname);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { host: bare(u.hostname), port, path: u.pathname };
  } catch {
    return null;
  }
}

/** This PC by any of its names. */
function thisPc(host: string, env: NodeJS.ProcessEnv): boolean {
  if (isLoopbackHost(host) || host === "0.0.0.0" || host === "::") return true;
  // Bound to every address (0.0.0.0), Hearth answers on each of this PC's.
  const bound = bare(env.HEARTH_HOST ?? "");
  const here =
    bound === "0.0.0.0" || bound === "::"
      ? Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((a) => bare(a.address)))
      : [bound];
  return here.includes(host);
}

/** The ports Hearth answers on here: its own, and those of its addresses on this PC. */
function hearthPorts(env: NodeJS.ProcessEnv): string[] {
  const own = [env.HEARTH_ORIGIN, env.HEARTH_LOCAL_ORIGIN, env.HEARTH_SERVER_URL]
    .map((o) => hostOf(o))
    .filter((o) => o && thisPc(o.host, env));
  return [env.HEARTH_PORT || "4400", ...own.map((o) => o!.port)];
}

/**
 * Whether an address is one of Hearth's own pages: where you open it from elsewhere
 * (HEARTH_ORIGIN, on any port), or Hearth's own ports on this PC, where other apps answer on the
 * rest (a dev server on :3000). Jarvis has its own actions for all of it, so a press, a key or
 * typing there is never its own to do. Hearth's dev server, a proxy or an alias is told by the
 * mark in its head (HEARTH_MARK) instead. Chrome's test page is Hearth's too, but has nothing
 * behind it.
 */
export function isHearthPage(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const at = hostOf(url);
  if (!at?.host || at.path === TEST_PAGE_PATH) return false;
  if (thisPc(at.host, env)) return hearthPorts(env).includes(at.port);
  return [env.HEARTH_ORIGIN, env.HEARTH_LOCAL_ORIGIN].some((o) => o && hostOf(o)?.host === at.host);
}

/**
 * Whether an address is one of Hearth's own requests rather than a page (/api/...): one opened in
 * your Chrome goes with your sign-in, so it could start something only you should, such as
 * connecting a Google account. Chrome's test page is the exception, as above.
 */
export function isHearthApi(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const at = hostOf(url);
  return Boolean(at?.path.startsWith("/api/")) && isHearthPage(url, env);
}

/** Hearth's own page says so in its head, whatever address reached it (a proxy, an alias). */
export const HEARTH_MARK = 'meta[name="hearth-build"]';

/** The floor a piece of text (a button's name, a dialog's message) hits, if any. */
export function floorOfText(text: string): Floor | null {
  if (FLOOR.money.test(text)) return "money";
  if (FLOOR.payment.test(text)) return "payment";
  if (FLOOR.account.test(text)) return "account";
  if (FLOOR.security.test(text)) return "security";
  return null;
}

/**
 * Accepting a dialog: an alert or a prompt sends nothing by itself, nor does leaving a page; a
 * confirm sends if its message says so ("Delete this message?").
 */
export function dialogVerdict(dialog: { type: string; message: string }): Verdict {
  if (dialog.type !== "confirm") return FREE;
  const floor = floorOfText(dialog.message);
  const verb = VERBS.exec(dialog.message);
  if (!floor && !verb) return FREE;
  return { sends: true, floor, why: `confirm "${(verb?.[0] ?? "it").toLowerCase()}"` };
}

/** Whether the owner trusts the site an address is on (Settings → Chrome → Trusted sites). */
export async function isTrusted(ctx: ActionContext, url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const sites = await getSetting(ctx.tx, "browser.sites");
  return onSiteList(host, sites.allowed) && !onSiteList(host, sites.blocked);
}
