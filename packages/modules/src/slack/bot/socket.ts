// Jarvis's Slack socket as pure functions (D62): what Slack sends over Socket Mode, which of it
// counts, and what Hearth answers. Nothing here touches the network or the database, so the
// worker's client (apps/worker/src/slack-bot.ts) and catch-up (catchup.ts) hear by one set of
// rules: our app, our workspace, our bot, and a person in the workspace writing.
import type { slackInbound } from "@hearth/db";
import { type Raw, str } from "../api.ts";

export type InboundRow = typeof slackInbound.$inferInsert;

/** What an envelope must carry to be ours: Jarvis's app, your workspace, Jarvis's bot user. */
export interface Ours {
  appId: string;
  teamId: string;
  botUserId: string;
}

/** One thing Slack said on the socket. */
export type Frame =
  | { type: "hello"; appId: string }
  | { type: "disconnect"; reason: string }
  | { type: "envelope"; envelopeId: string; kind: string; retryAttempt: number; payload: Raw }
  | { type: "other"; said: string };

export function parseFrame(data: string): Frame | null {
  let said: Raw;
  try {
    said = JSON.parse(data) as Raw;
  } catch {
    return null;
  }
  if (!said || typeof said !== "object") return null;
  const type = str(said.type) ?? "";
  if (type === "hello")
    return { type, appId: str((said.connection_info as Raw | undefined)?.app_id) ?? "" };
  if (type === "disconnect") return { type, reason: str(said.reason) ?? "" };
  const envelopeId = str(said.envelope_id);
  if (envelopeId)
    return {
      type: "envelope",
      envelopeId,
      kind: type,
      retryAttempt: typeof said.retry_attempt === "number" ? said.retry_attempt : 0,
      payload: (said.payload as Raw | undefined) ?? {},
    };
  return { type: "other", said: type };
}

/** The ack Slack waits for. It goes only after the envelope is stored (inbound.ts). */
export const ackOf = (envelopeId: string) => JSON.stringify({ envelope_id: envelopeId });

/**
 * What a disconnect asks of Hearth. Slack warns before it closes a socket and asks for a fresh one
 * now and then: the new socket opens first, so nothing falls between them. link_disabled means
 * Socket Mode is off for the app, which only you can fix.
 */
export function onDisconnect(reason: string): "handover" | "revoked" | "reconnect" {
  if (reason === "warning" || reason === "refresh_requested") return "handover";
  if (reason === "link_disabled") return "revoked";
  return "reconnect";
}

/** Waits between tries to connect, in seconds; the last repeats. */
export const BACKOFF_S = [1, 2, 5, 15, 30, 60, 120] as const;
/** A socket that stayed up this long starts the ladder over. */
export const BACKOFF_RESET_MS = 5 * 60_000;

/**
 * How long to wait before try `attempt` (0 first): the ladder, give or take 20% so a restart of
 * Slack's side doesn't have every client back at once, and never sooner than Slack's Retry-After.
 */
export function backoffMs(attempt: number, random = Math.random, retryAfterS?: number): number {
  const step = BACKOFF_S[Math.min(Math.max(attempt, 0), BACKOFF_S.length - 1)]!;
  const wait = Math.round(step * 1000 * (0.8 + 0.4 * random()));
  return Math.max(wait, (retryAfterS ?? 0) * 1000);
}

/** A message as the socket delivers it, or as catch-up reads it back. */
export interface Heard {
  channel: string;
  ts: string;
  user?: string;
  botId?: string;
  appId?: string;
  subtype?: string;
  hidden?: boolean;
  text: string;
  threadTs?: string;
  /** Every team the message names: its author's, and the one it was shared from. */
  teams: string[];
}

export const heardOf = (m: Raw, channel = str(m.channel) ?? ""): Heard => ({
  channel,
  ts: str(m.ts) ?? "",
  user: str(m.user),
  botId: str(m.bot_id),
  appId: str(m.app_id),
  subtype: str(m.subtype),
  hidden: m.hidden === true,
  text: str(m.text) ?? "",
  threadTs: str(m.thread_ts),
  teams: [m.user_team, m.source_team, m.team].map(str).filter((t): t is string => Boolean(t)),
});

/** Slackbot, which no one writes as. */
const SLACKBOT = "USLACKBOT";
/** The only kinds of message that count: a file's text, and a thread reply sent to the channel. */
const COUNTED_SUBTYPES: ReadonlySet<string> = new Set(["file_share", "thread_broadcast"]);
/** slack_inbound.text holds at most this much (0033). */
export const INBOUND_TEXT_MAX = 4000;

/**
 * Whether a message is someone in the workspace writing (D62). Edits and deletions, bots and apps
 * (Jarvis included), Slackbot, and anyone from another org are dropped before anything is stored.
 * Guests and deactivated users are told apart later, by the take loop, since telling needs a call
 * to Slack and nothing is called before the ack.
 */
export function counts(m: Heard, ours: Ours): boolean {
  if (!m.channel || !m.ts || !m.user) return false;
  if (m.hidden || (m.subtype && !COUNTED_SUBTYPES.has(m.subtype))) return false;
  if (m.botId || m.appId) return false;
  if (m.user === ours.botUserId || m.user === SLACKBOT) return false;
  return m.teams.every((t) => t === ours.teamId);
}

/** The kind of place a message is in, from its id: D is a DM, G a private channel or group. */
const placeOf = (channel: string) =>
  channel.startsWith("D") ? "im" : channel.startsWith("G") ? "group" : "channel";

export function inboundRow(
  m: Heard,
  teamId: string,
  source: "event" | "catchup",
  at: Date,
  extra: { channelType?: string; eventId?: string } = {},
): InboundRow {
  return {
    channelId: m.channel,
    ts: m.ts,
    teamId,
    userId: m.user ?? "",
    threadTs: m.threadTs ?? null,
    channelType: extra.channelType ?? placeOf(m.channel),
    subtype: (m.subtype as InboundRow["subtype"]) ?? null,
    text: m.text.slice(0, INBOUND_TEXT_MAX),
    source,
    eventId: extra.eventId ?? null,
    receivedAt: at,
  };
}

/** What to do with an envelope: store a message, stop because Slack revoked Jarvis, or drop it. */
export type Hearing =
  | { kind: "store"; row: InboundRow }
  | { kind: "revoked"; code: string }
  | { kind: "drop"; why: string };

const drop = (why: string): Hearing => ({ kind: "drop", why });

/**
 * Whether Slack delivered the event for Jarvis's bot. An app can also have events for the users
 * who installed it; one of yours would bring in your own DMs with other people as if they were
 * written to Jarvis.
 */
function forTheBot(payload: Raw, ours: Ours): boolean {
  const auths = (payload.authorizations as Raw[] | undefined) ?? [];
  return auths.some((a) => a.user_id === ours.botUserId && a.is_bot !== false);
}

/** An events_api envelope's payload, checked before anything is stored (D62). */
export function hear(payload: Raw, ours: Ours, at: Date): Hearing {
  if (str(payload.api_app_id) !== ours.appId) return drop("another app");
  if (str(payload.team_id) !== ours.teamId) return drop("another workspace");
  const event = (payload.event as Raw | undefined) ?? {};
  const type = str(event.type) ?? "";
  if (type === "app_uninstalled") return { kind: "revoked", code: type };
  if (type === "tokens_revoked") {
    // Your own token being revoked is the poller's to notice; this is about the bot's.
    const bots = ((event.tokens as Raw | undefined)?.bot as unknown[] | undefined) ?? [];
    return bots.includes(ours.botUserId) ? { kind: "revoked", code: type } : drop("not the bot");
  }
  if (type === "message" && str(event.channel_type) !== "im") return drop("not a DM to Jarvis");
  if (type !== "message" && type !== "app_mention") return drop(`a ${type || "blank"} event`);
  if (!forTheBot(payload, ours)) return drop("not for Jarvis's bot");
  const m = heardOf(event);
  if (!counts(m, ours)) return drop("not someone writing");
  return {
    kind: "store",
    row: inboundRow(m, ours.teamId, "event", at, {
      ...(type === "message" ? { channelType: "im" } : {}),
      eventId: str(payload.event_id),
    }),
  };
}

/** A time as a Slack ts ("1700000000.000100"), for marks that start at now. */
export function slackTs(at: Date): string {
  const ms = at.getTime();
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}`;
}
