// Which email domains stand for a company. Free-mail providers and role accounts (info@,
// noreply@) never make one; a friend on gmail.com is still a person, just without a company.

const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "msn.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "mail.com",
  "zoho.com",
  "hey.com",
  "fastmail.com",
  "tutanota.com",
  "tuta.io",
  "duck.com",
  "qq.com",
  "163.com",
  "126.com",
  "mail.ru",
  "web.de",
  "t-online.de",
  "free.fr",
  "orange.fr",
  "laposte.net",
  "libero.it",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "cox.net",
  "charter.net",
  "earthlink.net",
  "optonline.net",
  "btinternet.com",
  "sky.com",
  "rocketmail.com",
  "ymail.com",
  "hushmail.com",
  "inbox.com",
  "naver.com",
  "rediffmail.com",
  "privaterelay.appleid.com",
]);
/** Providers with a domain per country: yahoo.co.uk, hotmail.fr, gmx.de. */
const FREE_MAIL_NAMES = new Set(["yahoo", "hotmail", "outlook", "live", "gmx", "yandex"]);

const ROLE =
  /^(info|hello|hi|contact|support|help|helpdesk|sales|admin|administrator|office|team|billing|accounts?|invoices?|finance|hr|jobs|careers|recruiting|press|media|marketing|news|newsletters?|notifications?|alerts?|no-?reply|do-?not-?reply|mailer-daemon|postmaster|webmaster|security|abuse|privacy|legal|service|customerservice|feedback|orders?|bookings?|reservations?|events?|community|partners?|enquiries|inquiries)([+._-].*)?$/i;

/** Suffixes where the company name sits one label further in: acme.co.uk. */
const TWO_LEVEL = /\.(co|com|org|net|ac|gov|edu|ne|or)\.[a-z]{2}$/;

/** "mail.eu.acme.co.uk" → "acme.co.uk". */
export function baseDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  return parts.slice(TWO_LEVEL.test(domain.toLowerCase()) ? -3 : -2).join(".");
}

export function isRoleAddress(address: string): boolean {
  return ROLE.test(address.slice(0, address.lastIndexOf("@")));
}

export function isFreeMail(domain: string): boolean {
  const base = baseDomain(domain);
  return FREE_MAIL.has(base) || FREE_MAIL_NAMES.has(base.split(".")[0]!);
}

/** The company domain an address stands for, or null (free mail, a role account, no domain). */
export function companyDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const domain = address.slice(at + 1).toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  if (isFreeMail(domain) || isRoleAddress(address)) return null;
  return baseDomain(domain);
}

/** "acme-labs.co.uk" → "Acme Labs". You can rename it. */
export function companyName(domain: string): string {
  return domain
    .split(".")[0]!
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
