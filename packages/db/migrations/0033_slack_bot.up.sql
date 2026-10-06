-- Jarvis talks to Otopair members as its own bot, and a member's turn knows only what you've
-- shared (D62). Reading Slack doesn't change: your own token still reads it, and Hearth never
-- posts as you. Everything here stays unused until `slack.bot.membersOn` is turned on.

-- A new kind of principal: someone in your workspace writing to the bot, made the first time
-- they write (member:slack:<team>:<user>). The kind lives on the principal row, so a held reply
-- is still a member's call after you approve it. The kernel refuses a member every action that
-- doesn't name `member` as a caller. member:slack:<team>:* is the team's wildcard: it holds the
-- standing rule "Jarvis answers members on its own".
ALTER TABLE principal DROP CONSTRAINT principal_kind_check;
ALTER TABLE principal ADD CONSTRAINT principal_kind_check CHECK (kind IN (
  'owner', 'agent', 'mcp_client', 'integration', 'system', 'member'
));

-- A member's message starts a turn as that member. Budgets count them by trigger and time, and
-- claiming takes your reactive turns first, then theirs, then proactive ones.
ALTER TABLE jarvis_turn DROP CONSTRAINT jarvis_turn_trigger_check;
ALTER TABLE jarvis_turn ADD CONSTRAINT jarvis_turn_trigger_check CHECK (trigger IN (
  'chat', 'mention', 'assignment', 'approval', 'watch', 'reflex', 'routine', 'voice_command',
  'slack_member'
));
CREATE INDEX jarvis_turn_trigger ON jarvis_turn (trigger, status, queued_at);

-- The bot, in the workspace your own token reads. Only the worker opens its tokens. Each is
-- sealed under its own context ('<team>:bot', '<team>:app'), so a token moved to the other
-- column won't open.
CREATE TABLE slack_bot (
  team_id text PRIMARY KEY REFERENCES slack_workspace (team_id) ON DELETE CASCADE,
  -- A0C0RPY4WKV: every envelope must carry it, as `hello` said.
  app_id text NOT NULL,
  bot_user_id text NOT NULL,
  bot_id text NOT NULL,
  -- The bot's DM with you, opened once at connect: the only place a message can be yours.
  owner_im text NOT NULL,
  -- The install that connected the bot. Only it opens the socket, so a dev copy with a restored
  -- database can't take the live events.
  install_id text NOT NULL,
  bot_token text NOT NULL,
  app_token text NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  -- Nothing older than this Slack ts is read in: it's set to then on the first connect. Catch-up
  -- of @Jarvis in channels reads on from mentions_ts, and moves it only past what it read.
  listen_from text,
  mentions_ts text,
  -- The socket's health (sync.slack_bot), kept as connector-health.ts keeps the pollers'.
  -- 'revoked' stops the socket and the sender until new tokens are given.
  sync_state text NOT NULL DEFAULT 'ok' CHECK (sync_state IN ('ok', 'failing', 'revoked')),
  failures integer NOT NULL DEFAULT 0,
  failing_since timestamptz,
  last_error text,
  -- When the socket was last connected.
  synced_at timestamptz
);

-- Who a member is to Jarvis. Identity is by Slack id only, read with your own token: guests,
-- Slack Connect users and deactivated users are never answered, and are checked again daily.
-- Everyone starts at 'relay' (a message passed to you); 'schedule' (free time and meeting
-- requests) is given one person at a time. A member's DM replies go out on their own unless you
-- put them on review.
ALTER TABLE slack_user
  ADD COLUMN principal text UNIQUE REFERENCES principal (id) ON DELETE SET NULL,
  ADD COLUMN tier text NOT NULL DEFAULT 'relay' CHECK (tier IN ('blocked', 'relay', 'schedule')),
  ADD COLUMN replies text NOT NULL DEFAULT 'auto' CHECK (replies IN ('auto', 'review')),
  ADD COLUMN vip boolean NOT NULL DEFAULT false,
  ADD COLUMN guest boolean NOT NULL DEFAULT false,
  ADD COLUMN external boolean NOT NULL DEFAULT false,
  ADD COLUMN deleted boolean NOT NULL DEFAULT false,
  ADD COLUMN checked_at timestamptz;

-- Where Jarvis answers @mentions. Off until you turn a channel on, and only a channel you're in,
-- with no guests and not shared with another org (checked again hourly). Its replies wait for
-- your yes unless you set them to go out on their own. A group DM or a DM is never on.
ALTER TABLE slack_channel
  ADD COLUMN jarvis_tier text NOT NULL DEFAULT 'off'
    CHECK (jarvis_tier IN ('off', 'relay', 'schedule')),
  ADD COLUMN jarvis_replies text NOT NULL DEFAULT 'review'
    CHECK (jarvis_replies IN ('auto', 'review')),
  ADD COLUMN jarvis_checked_at timestamptz,
  ADD CONSTRAINT slack_channel_jarvis_where
    CHECK (jarvis_tier = 'off' OR kind IN ('channel', 'private'));

-- Plain text you write in Settings for Jarvis to share: office hours, status, how to reach you.
-- For everyone (users null), or for the members named. Only you write them, so nothing Jarvis
-- reads can mark something shareable. A channel turn sees only the ones for everyone.
CREATE TABLE slack_answer (
  id uuid PRIMARY KEY,
  team_id text NOT NULL REFERENCES slack_workspace (team_id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  body text NOT NULL CHECK (char_length(body) <= 4000),
  users text[] CHECK (users IS NULL OR cardinality(users) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A place in Slack and the conversation Jarvis has there: one per member DM (thread_ts '',
-- however they thread in it), one per channel thread, and your own DM with the bot. Replies are
-- addressed from here, never from what the model wrote.
CREATE TABLE slack_thread (
  channel_id text NOT NULL,
  thread_ts text NOT NULL DEFAULT '',
  team_id text NOT NULL REFERENCES slack_workspace (team_id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL UNIQUE REFERENCES entity (id) ON DELETE CASCADE,
  -- Who reads the answer: a member in their DM, everyone in a channel, or you.
  audience text NOT NULL CHECK (audience IN ('member', 'channel', 'owner')),
  -- The member a DM is with.
  member text REFERENCES principal (id) ON DELETE CASCADE,
  -- The newest message read in here (a Slack ts); catch-up reads on from it.
  mark text,
  -- Paused by you, or by the loop breaker (20 posts in 10 minutes pauses it for an hour).
  paused_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, thread_ts),
  CHECK (audience <> 'member' OR member IS NOT NULL)
);
CREATE INDEX slack_thread_member ON slack_thread (member) WHERE member IS NOT NULL;

-- Every message the bot hears, stored before Slack is told it arrived, so a crash between the
-- two means Slack sends it again. (channel_id, ts) stores each message once however it comes: a
-- retry, two sockets at once, an app_mention and a message.im for the same message, catch-up.
-- The take loop then works out who wrote it and which conversation it belongs to, and a turn
-- folds in the messages waiting in its conversation. Text is cleared after 30 days.
CREATE TABLE slack_inbound (
  channel_id text NOT NULL,
  ts text NOT NULL,
  team_id text NOT NULL,
  user_id text NOT NULL,
  thread_ts text,
  -- 'im' for the bot's DMs, else the kind of channel it was @mentioned in.
  channel_type text NOT NULL,
  -- Null, 'file_share' or 'thread_broadcast': the only kinds that count.
  subtype text,
  text text CHECK (char_length(text) <= 4000),
  -- 'event' from the socket, or 'catchup' from reading what was missed.
  source text NOT NULL CHECK (source IN ('event', 'catchup')),
  event_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- When the take loop handled it, what it decided, and where it went.
  taken_at timestamptz,
  outcome text,
  conversation_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  -- The turn that folded it in.
  turn_id uuid,
  PRIMARY KEY (channel_id, ts)
);
CREATE INDEX slack_inbound_untaken ON slack_inbound (ts) WHERE taken_at IS NULL;
-- How a turn finds what's waiting in its conversation, and what deleting a conversation follows.
CREATE INDEX slack_inbound_conversation ON slack_inbound (conversation_id, ts);

-- Every post Jarvis makes, whoever asked for it: a member turn's answer, an approved reply, your
-- own send, a fixed note. The worker's sender posts each once: the dedupe key (answer:<turn>
-- for a turn's answer) keeps a rerun from adding a second row, and a post that may have gone out
-- is read back by its id before it's sent again.
CREATE TABLE slack_outbox (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  team_id text NOT NULL REFERENCES slack_workspace (team_id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  -- Null: at the top level. A channel @mention is answered in its thread.
  thread_ts text,
  -- Set for an ephemeral note: the only one who sees it.
  ephemeral_to text,
  text text NOT NULL,
  -- 'answer': a member turn's reply (links you didn't share are removed); 'send': you, or Jarvis
  -- for you; 'note': a fixed note from a closed set of templates.
  kind text NOT NULL CHECK (kind IN ('answer', 'send', 'note')),
  conversation_id uuid REFERENCES entity (id) ON DELETE SET NULL,
  turn_id uuid,
  approval_id uuid REFERENCES approval (id) ON DELETE SET NULL,
  created_by text NOT NULL REFERENCES principal (id),
  -- 'unknown': a channel post Hearth can't read back; it may not have gone out, and isn't retried.
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'sending', 'sent', 'failed', 'expired', 'unknown'
  )),
  attempts integer NOT NULL DEFAULT 0,
  -- Pacing and Retry-After: not before this.
  not_before timestamptz NOT NULL DEFAULT now(),
  sending_at timestamptz,
  -- The post's Slack ts, once it's out.
  sent_ts text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Still waiting a day later, it expires and you're told.
  expires_at timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX slack_outbox_due ON slack_outbox (not_before) WHERE state IN ('queued', 'sending');
CREATE INDEX slack_outbox_conversation ON slack_outbox (conversation_id, created_at);
