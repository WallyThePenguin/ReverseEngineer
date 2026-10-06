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

/**
 * What kind of identity is calling. A `member` is someone in your Slack workspace writing to
 * Jarvis's bot: their turn runs as them, and the kernel refuses them every action that doesn't
 * name `member` as a caller (D62).
 */
export const PRINCIPAL_KINDS = [
  "owner",
  "agent",
  "mcp_client",
  "integration",
  "system",
  "member",
] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** A Slack member's principal, made the first time they write to Jarvis (D62). */
export function memberPrincipal(teamId: string, userId: string): string {
  return `member:slack:${teamId}:${userId}`;
}

/**
 * The wildcard principal for every member of a member's team, `member:slack:<team>:*`. It holds
 * the standing rule "Jarvis answers members on its own" (D62). Null for anything else.
 */
export function memberWildcard(principal: string): string | null {
  const parts = principal.split(":");
  if (parts.length !== 4 || parts[0] !== "member" || parts[1] !== "slack" || !parts[2]) return null;
  return memberPrincipal(parts[2], "*");
}

/**
 * `conversation.started_via` for a member's conversation with Jarvis. Only that member's turns
 * run there: an owner turn resuming its agent session would bring your data into it (D62).
 */
export const MEMBER_CONVERSATION = "slack_member";

/**
 * Where the request ultimately came from. A turn Jarvis takes because an email arrived is
 * "untrusted" even though Jarvis is the caller: outside text can never raise permissions.
 */
export const ORIGINS = ["owner", "agent", "untrusted", "system"] as const;
export type Origin = (typeof ORIGINS)[number];

/** The surface a call came through. "slack": a message to Jarvis's Slack bot (D62). */
export const VIAS = [
  "ui",
  "cli",
  "device",
  "mcp",
  "jarvis",
  "integration",
  "system",
  "slack",
] as const;
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
