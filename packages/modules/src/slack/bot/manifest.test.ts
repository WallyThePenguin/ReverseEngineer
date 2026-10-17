// The manifest Settings shows for Jarvis's Slack app (D62), held to the exact text: a change to a
// scope or an event shows up here, next to the reason it's allowed.
import { describe, expect, it } from "vitest";
import { checkScopes, slackManifest } from "./manifest.ts";

const MANIFEST = `# The Jarvis app in Slack (A0C0RPY4WKV). Merge this in under App Manifest (YAML), keeping
# your app id and redirect settings, then reinstall the app to the workspace.
display_information:
  name: Jarvis
  description: "Sam Lee's assistant. It runs on their PC; when it's off, replies wait."
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Jarvis
    always_online: false
oauth_config:
  scopes:
    user:
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - users:read
      - users:read.email
      - search:read
      # Kept for something else of yours. Nook never writes with your token.
      - chat:write
      - im:write
      - reactions:write
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - im:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;

describe("the Slack app manifest", () => {
  it("sets up Jarvis's app: Socket Mode, the bot's five scopes and four events, your reading list, and your write scopes kept", () => {
    expect(slackManifest("Sam Lee")).toBe(MANIFEST);
  });

  it("names whose assistant Jarvis is as a quoted string, whatever the name, or no one", () => {
    expect(slackManifest('Ana "A": x\n#y')).toContain(
      `  description: "Ana \\"A\\": x\\n#y's assistant. It runs on their PC; when it's off, replies wait."\n`,
    );
    expect(slackManifest(null)).toContain(
      `  description: "A personal assistant. It runs on its owner's PC; when it's off, replies wait."\n`,
    );
  });

  it("checks granted scopes against wanted ones, leaving kept ones alone", () => {
    expect(
      checkScopes(
        ["im:read", "users:read", "chat:write", "files:read"],
        ["im:read", "im:write"],
        ["chat:write"],
      ),
    ).toEqual({ missing: ["im:write"], extra: ["files:read", "users:read"] });
  });
});
