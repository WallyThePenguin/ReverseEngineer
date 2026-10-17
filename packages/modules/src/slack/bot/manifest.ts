// The Slack app Jarvis's bot runs as (D62): your existing app A0C0RPY4WKV, set up once from the
// manifest Settings shows. One manifest covers both tokens: your own (xoxp), which only reads, and
// the bot's (xoxb), which posts as Jarvis. Connecting checks the scopes Slack says each token has
// against these lists, so the app and Hearth can't quietly drift apart.

/** The one app whose socket Hearth listens on: every envelope must carry it (D62). */
export const JARVIS_APP_ID = "A0C0RPY4WKV";

/** What your own token reads with (D48), unchanged by the bot. */
export const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
  "users:read.email",
  "search:read",
] as const;

/**
 * Your app's user write scopes, kept because something else of yours may use them. Hearth never
 * calls a write method with your token (api.ts USER_TOKEN_METHODS), so it doesn't warn about
 * them either (D62).
 */
export const KEPT_USER_SCOPES = ["chat:write", "im:write", "reactions:write"] as const;

/**
 * The bot's scopes, exactly these. Hearth warns about any other the bot has: channel history or
 * users:read on the bot would let a leaked bot token read what your own token already reads.
 */
export const BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
] as const;

/** The bot's events: @Jarvis, DMs to it, and word that it was uninstalled or its tokens revoked. */
export const BOT_EVENTS = ["app_mention", "message.im", "app_uninstalled", "tokens_revoked"];

/** What the app-level token (xapp) needs to open the socket. */
export const APP_TOKEN_SCOPE = "connections:write";

export interface ScopeCheck {
  /** Asked for but not granted: connecting is refused. */
  missing: string[];
  /** Granted but not asked for (and not kept on purpose). */
  extra: string[];
}

/** What a token's granted scopes lack, and have beyond what's wanted. */
export function checkScopes(
  granted: readonly string[],
  wanted: readonly string[],
  kept: readonly string[] = [],
): ScopeCheck {
  const has = new Set(granted);
  return {
    missing: wanted.filter((s) => !has.has(s)),
    extra: granted.filter((s) => !wanted.includes(s) && !kept.includes(s)).sort(),
  };
}

const list = (items: readonly string[], pad: string) => items.map((s) => `${pad}- ${s}`);

/**
 * The manifest to merge into the app (App Manifest → YAML), keeping its app id and redirect
 * settings. `owner` names whose assistant Jarvis is; a JSON string is also a YAML string, so any
 * name is safe in it.
 */
export function slackManifest(owner: string | null): string {
  const description = owner
    ? `${owner}'s assistant. It runs on their PC; when it's off, replies wait.`
    : "A personal assistant. It runs on its owner's PC; when it's off, replies wait.";
  return [
    `# The Jarvis app in Slack (${JARVIS_APP_ID}). Merge this in under App Manifest (YAML), keeping`,
    "# your app id and redirect settings, then reinstall the app to the workspace.",
    "display_information:",
    "  name: Jarvis",
    `  description: ${JSON.stringify(description)}`,
    "features:",
    "  app_home:",
    "    home_tab_enabled: false",
    "    messages_tab_enabled: true",
    "    messages_tab_read_only_enabled: false",
    "  bot_user:",
    "    display_name: Jarvis",
    "    always_online: false",
    "oauth_config:",
    "  scopes:",
    "    user:",
    ...list(USER_SCOPES, "      "),
    "      # Kept for something else of yours. Nook never writes with your token.",
    ...list(KEPT_USER_SCOPES, "      "),
    "    bot:",
    ...list(BOT_SCOPES, "      "),
    "settings:",
    "  event_subscriptions:",
    "    bot_events:",
    ...list(BOT_EVENTS, "      "),
    "  interactivity:",
    "    is_enabled: false",
    "  org_deploy_enabled: false",
    "  socket_mode_enabled: true",
    "  token_rotation_enabled: false",
    "",
  ].join("\n");
}
