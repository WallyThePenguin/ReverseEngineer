// Risk classes, caller identities and trust levels (PLAN.md sections 5.4 and 5.5).

/**
 * How much an action can affect the world outside Hearth.
 * - read: looks only.
 * - internal: changes Hearth records only (a task, a note, a link).
 * - self_external: changes your own outside accounts in ways only you see (your calendar).
 * - outward: other people see it (send an email, post in Slack, invite someone).
 * - destructive: hard to undo (delete for good, empty trash).
 * - secret: touches credentials or tokens.
 */
export const RISKS = [
  "read",
  "internal",
  "self_external",
  "outward",
  "destructive",
  "secret",
] as const;
export type Risk = (typeof RISKS)[number];

/** What kind of identity is calling. */
export const PRINCIPAL_KINDS = ["owner", "agent", "mcp_client", "integration", "system"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/**
 * Where the request ultimately came from. A turn Jarvis takes because an email arrived is
 * "untrusted" even though Jarvis is the caller: outside text can never raise permissions.
 */
export const ORIGINS = ["owner", "agent", "untrusted", "system"] as const;
export type Origin = (typeof ORIGINS)[number];

/** The surface a call came through. */
export const VIAS = ["ui", "cli", "device", "mcp", "jarvis", "integration", "system"] as const;
export type Via = (typeof VIAS)[number];

/** The weaker of two origins. Trust only ever goes down along a chain of causes. */
export function weakerOrigin(a: Origin, b: Origin): Origin {
  const rank: Record<Origin, number> = { owner: 3, system: 2, agent: 1, untrusted: 0 };
  return rank[a] <= rank[b] ? a : b;
}

/** Sites Jarvis may open freely even after reading outside content, and sites it never opens (D25). */
export interface SiteRules {
  allowed: string[];
  blocked: string[];
}

/** Password managers, account security and payments. Add your bank in Settings. */
export const DEFAULT_SITE_RULES: SiteRules = {
  allowed: [],
  blocked: [
    "myaccount.google.com",
    "passwords.google.com",
    "1password.com",
    "bitwarden.com",
    "lastpass.com",
    "dashlane.com",
    "paypal.com",
  ],
};

/** An http(s) address without its #fragment, or null if it isn't one. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** True when the host is one of the sites, or a subdomain of one. */
export function onSiteList(host: string, sites: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return sites.some((s) => {
    const site = s.trim().toLowerCase().replace(/^\*\./, "");
    return site !== "" && (h === site || h.endsWith(`.${site}`));
  });
}

/** Wraps outside text so a model reads it as data, never as instructions. */
export function asUntrusted(text: string, source: string): string {
  const safeSource = source.replace(/["<>]/g, "");
  const body = text.replaceAll("</untrusted", "&lt;/untrusted");
  return `<untrusted source="${safeSource}">\n${body}\n</untrusted>`;
}
