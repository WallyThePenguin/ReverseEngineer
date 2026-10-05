// The socket's protocol as pure functions (D62): what Slack's frames say, how long to wait before
// trying again, and which envelopes are someone in the workspace writing to Jarvis.
import { describe, expect, it } from "vitest";
import {
  ackOf,
  BACKOFF_S,
  backoffMs,
  hear,
  INBOUND_TEXT_MAX,
  type Ours,
  onDisconnect,
  parseFrame,
  slackTs,
} from "./socket.ts";

const ours: Ours = { appId: "A0C0RPY4WKV", teamId: "T1", botUserId: "UJARVIS" };
const at = new Date("2026-10-05T12:00:00.250Z");

const payload = (event: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  team_id: "T1",
  api_app_id: "A0C0RPY4WKV",
  event_id: "Ev1",
  authorizations: [{ team_id: "T1", user_id: "UJARVIS", is_bot: true }],
  event,
  ...over,
});
const dm = (over: Record<string, unknown> = {}) => ({
  type: "message",
  channel: "DUANA",
  channel_type: "im",
  user: "UANA",
  text: "hi",
  ts: "1790000000.000100",
  team: "T1",
  ...over,
});

describe("Slack's frames", () => {
  it("reads hello, disconnect and envelopes, and acks by envelope id", () => {
    expect(
      parseFrame('{"type":"hello","num_connections":1,"connection_info":{"app_id":"A0C0RPY4WKV"}}'),
    ).toEqual({ type: "hello", appId: "A0C0RPY4WKV" });
    expect(parseFrame('{"type":"disconnect","reason":"warning"}')).toEqual({
      type: "disconnect",
      reason: "warning",
    });
    expect(
      parseFrame('{"envelope_id":"e1","type":"events_api","retry_attempt":2,"payload":{"a":1}}'),
    ).toEqual({
      type: "envelope",
      envelopeId: "e1",
      kind: "events_api",
      retryAttempt: 2,
      payload: { a: 1 },
    });
    expect(parseFrame("not json")).toBeNull();
    expect(JSON.parse(ackOf("e1"))).toEqual({ envelope_id: "e1" });
  });

  it("hands over on a warning or a refresh, stops on link_disabled, and reconnects otherwise", () => {
    expect(onDisconnect("warning")).toBe("handover");
    expect(onDisconnect("refresh_requested")).toBe("handover");
    expect(onDisconnect("link_disabled")).toBe("revoked");
    expect(onDisconnect("socket_closed")).toBe("reconnect");
  });
});

describe("waiting between tries", () => {
  it("climbs 1, 2, 5, 15, 30, 60, then 120 s, give or take 20%, and never under Retry-After", () => {
    expect(BACKOFF_S.map((_, i) => backoffMs(i, () => 0.5))).toEqual([
      1000, 2000, 5000, 15_000, 30_000, 60_000, 120_000,
    ]);
    expect(backoffMs(20, () => 0.5)).toBe(120_000);
    expect(backoffMs(0, () => 0)).toBe(800);
    expect(backoffMs(0, () => 1)).toBe(1200);
    expect(backoffMs(3, () => 1)).toBe(18_000);
    expect(backoffMs(0, () => 0.5, 30)).toBe(30_000);
    expect(backoffMs(6, () => 0.5, 30)).toBe(120_000);
  });
});

describe("who is heard", () => {
  it("stores a member's DM and an @mention, with the event's id", () => {
    expect(hear(payload(dm()), ours, at)).toEqual({
      kind: "store",
      row: {
        channelId: "DUANA",
        ts: "1790000000.000100",
        teamId: "T1",
        userId: "UANA",
        threadTs: null,
        channelType: "im",
        subtype: null,
        text: "hi",
        source: "event",
        eventId: "Ev1",
        receivedAt: at,
      },
    });
    const mention = { ...dm(), type: "app_mention", channel: "C1", thread_ts: "1.0" };
    delete (mention as Record<string, unknown>).channel_type;
    expect(hear(payload(mention), ours, at)).toMatchObject({
      kind: "store",
      row: { channelId: "C1", channelType: "channel", threadTs: "1.0" },
    });
  });

  it("drops anything that isn't someone in the workspace writing to Jarvis", () => {
    const dropped = {
      "another app": payload(dm(), { api_app_id: "A0OTHER" }),
      "another workspace": payload(dm(), { team_id: "T2" }),
      "a Slack Connect user": payload(dm({ user_team: "T9" })),
      "a message shared from another org": payload(dm({ source_team: "T9" })),
      "an author from another team": payload(dm({ team: "T9" })),
      "a bot": payload(dm({ bot_id: "B1" })),
      "an app": payload(dm({ app_id: "A0OTHER" })),
      "Jarvis itself": payload(dm({ user: "UJARVIS" })),
      Slackbot: payload(dm({ user: "USLACKBOT" })),
      "an edit": payload(dm({ subtype: "message_changed", hidden: true })),
      "a deletion": payload(dm({ subtype: "message_deleted" })),
      "a join": payload(dm({ subtype: "channel_join" })),
      "no author": payload(dm({ user: undefined })),
      "a channel message": payload(dm({ channel_type: "channel" })),
      "another event": payload({ type: "reaction_added", user: "UANA" }),
      "your own install's event": payload(dm(), {
        authorizations: [{ team_id: "T1", user_id: "UME", is_bot: false }],
      }),
      "an event with no authorization": payload(dm(), { authorizations: undefined }),
      "your own token revoked": payload({ type: "tokens_revoked", tokens: { oauth: ["UME"] } }),
    };
    for (const [what, p] of Object.entries(dropped))
      expect(hear(p, ours, at).kind, what).toBe("drop");
  });

  it("keeps a file's text and a broadcast thread reply, cut to 4,000 characters", () => {
    const file = hear(payload(dm({ subtype: "file_share", text: "x".repeat(5000) })), ours, at);
    expect(file).toMatchObject({ kind: "store", row: { subtype: "file_share" } });
    expect((file as { row: { text: string } }).row.text).toHaveLength(INBOUND_TEXT_MAX);
    expect(
      hear(payload(dm({ subtype: "thread_broadcast", thread_ts: "1.0" })), ours, at),
    ).toMatchObject({ kind: "store", row: { subtype: "thread_broadcast", threadTs: "1.0" } });
  });

  it("stops for the app uninstalled or the bot's token revoked, but only for ours", () => {
    expect(hear(payload({ type: "app_uninstalled" }), ours, at)).toEqual({
      kind: "revoked",
      code: "app_uninstalled",
    });
    expect(
      hear(payload({ type: "tokens_revoked", tokens: { bot: ["UJARVIS"] } }), ours, at),
    ).toEqual({ kind: "revoked", code: "tokens_revoked" });
    expect(
      hear(payload({ type: "app_uninstalled" }, { api_app_id: "A0OTHER" }), ours, at).kind,
    ).toBe("drop");
  });

  it("writes a time as a Slack ts", () => {
    expect(slackTs(at)).toBe(`${Math.floor(at.getTime() / 1000)}.250000`);
  });
});
