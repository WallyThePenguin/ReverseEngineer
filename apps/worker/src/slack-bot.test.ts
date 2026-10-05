// Jarvis's Slack socket hears and stores (D62): every envelope is stored before it's acked, each
// message once however often it comes, nothing is lost when Slack swaps sockets, a socket that
// went quiet is replaced, and only someone in the workspace writing to Jarvis is kept.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dm } from "./fake-slack-socket.ts";
import { type BotTest, botTest, pause, until } from "./slack-bot-testing.ts";

let k: BotTest;
beforeEach(async () => {
  k = await botTest();
});
afterEach(() => k.done());

/** Slack ts after Hearth started listening, so nothing is too old. */
const ts = (n: number) => `${1_790_000_000 + n}.000100`;

async function listening() {
  k.start();
  await k.fake.socket(1);
  await until(() => k.bot!.connected(), 5000, "the socket");
}

describe("storing, then acking", () => {
  it("stores and acks a burst of 50 messages, each within 3 seconds", async () => {
    await listening();
    const ids = Array.from({ length: 50 }, (_, i) =>
      k.fake.send(k.fake.payload(dm("UANA", `message ${i}`, ts(i)))),
    );
    const took = await Promise.all(ids.map((id) => k.fake.acked(id)));
    // Slack's own limit, the same on any machine, so it isn't scaled for a slow one.
    expect(Math.max(...took)).toBeLessThan(3000);
    const rows = await k.rows();
    expect(rows).toHaveLength(50);
    expect(rows[0]).toMatchObject({
      channelId: "DUANA",
      userId: "UANA",
      channelType: "im",
      source: "event",
      text: "message 0",
      teamId: "T1",
    });
  });

  it("doesn't ack what it couldn't store, and stores Slack's redelivery once", async () => {
    await listening();
    k.inbound.failNext = 1;
    const first = k.fake.send(k.fake.payload(dm("UANA", "hello?", ts(1))));
    await pause(300);
    expect(k.fake.acks.has(first)).toBe(false);
    expect(await k.rows()).toEqual([]);
    expect(k.logs.join("\n")).toMatch(/Slack will send it again/);

    await k.fake.acked(k.fake.redeliver(first));
    await k.fake.acked(k.fake.redeliver(first));
    expect((await k.rows()).map((r) => r.text)).toEqual(["hello?"]);
  });

  it("keeps one row for a repeated event, one message on two sockets, and an app_mention with its message.im", async () => {
    await listening();
    // The same event twice.
    const again = k.fake.payload(dm("UANA", "once", ts(1)));
    await k.fake.acked(k.fake.send(again));
    await k.fake.acked(k.fake.send(again));
    // Slack's two events for one message.
    await k.fake.acked(k.fake.send(k.fake.payload(dm("UBEN", "<@UJARVIS> hi", ts(2)))));
    const mention = { type: "app_mention", channel: "DUBEN", user: "UBEN", text: "<@UJARVIS> hi" };
    await k.fake.acked(k.fake.send(k.fake.payload({ ...mention, ts: ts(2), team: "T1" })));
    // Two sockets open at once, as during a handover, each given the same message.
    k.fake.holdHello = true;
    k.fake.disconnect("refresh_requested");
    const second = await k.fake.socket(2);
    const both = k.fake.payload(dm("UCAL", "on both", ts(3)));
    await k.fake.acked(k.fake.send(both, k.fake.sockets[0]));
    await k.fake.acked(k.fake.send(both, second));
    k.fake.sayHello(second);

    expect((await k.rows()).map((r) => [r.channelId, r.text])).toEqual([
      ["DUANA", "once"],
      ["DUBEN", "<@UJARVIS> hi"],
      ["DUCAL", "on both"],
    ]);
  });
});

describe("swapping sockets", () => {
  it("opens the new socket before closing the old on a warning, and loses nothing", async () => {
    await listening();
    const first = k.fake.sockets[0]!;
    await k.fake.acked(k.fake.send(k.fake.payload(dm("UANA", "before", ts(1)))));
    k.fake.holdHello = true;
    k.fake.disconnect("warning");
    const second = await k.fake.socket(2);
    // The old socket still listens until the new one is up.
    await k.fake.acked(k.fake.send(k.fake.payload(dm("UANA", "during", ts(2))), first));
    await k.fake.acked(k.fake.send(k.fake.payload(dm("UANA", "early", ts(3))), second));
    expect(first.readyState).toBe(first.OPEN);
    k.fake.sayHello(second);
    await until(() => first.readyState === first.CLOSED, 3000, "the old socket to close");
    await k.fake.acked(k.fake.send(k.fake.payload(dm("UANA", "after", ts(4))), second));

    expect((await k.rows()).map((r) => r.text)).toEqual(["before", "during", "early", "after"]);
    expect(k.fake.opens).toBe(2);
    // A handover doesn't wait.
    expect(k.waits).toEqual([]);
  });

  it("keeps a quiet socket that answers its pings", async () => {
    k.start({ helloWaitMs: 2000 });
    const socket = await k.fake.socket(1);
    await until(() => k.bot!.connected(), 5000, "the socket");
    // Past the wait for hello (2 s here, 15 s in the worker) with nothing said on the socket.
    await pause(2500);
    // A ping goes only once the last one's pong was heard, so five of them well inside the 5 s
    // pong wait mean the socket heard its pongs.
    await until(() => k.fake.pings(socket) >= 5, 4000, "five pings");
    expect(k.bot!.connected()).toBe(true);
    expect(k.fake.opens).toBe(1);
    expect(k.waits).toEqual([]);
    expect(await k.row()).toMatchObject({ syncState: "ok", failures: 0 });
  });

  it("drops a socket that stops answering pings, and connects again", async () => {
    // Pings every 100 ms here, 20 s in the worker; no pong in 100 ms (10 s) means it's dead.
    k.start({ pongWaitMs: 100 });
    const first = await k.fake.socket(1);
    await until(() => k.bot!.connected(), 5000, "the socket");
    k.fake.silence(first);
    await k.fake.socket(2, 3000);
    await until(() => first.readyState === first.CLOSED, 3000, "the dead socket to go");
    await until(() => k.bot!.connected(), 3000, "the new socket");
    expect(k.logs.join("\n")).toMatch(/closed \(no pong\); connecting again/);
    // The ladder's first step. Later ones aren't checked: the new socket also waits only 100 ms
    // for its pongs, which a busy machine can miss.
    expect(k.waits[0]).toBe(1000);
  });
});

describe("who is heard", () => {
  it("drops other apps, other workspaces, other orgs, bots, itself, Slackbot and edits, and keeps files and broadcasts", async () => {
    await listening();
    const dropped = [
      k.fake.payload(dm("UANA", "another app", ts(1)), { api_app_id: "A0SOMEONEELSE" }),
      k.fake.payload(dm("UANA", "another workspace", ts(2)), { team_id: "T2" }),
      k.fake.payload(dm("UEXT", "Slack Connect", ts(3), { user_team: "T9" })),
      k.fake.payload(dm("UEXT", "shared in", ts(4), { source_team: "T9" })),
      k.fake.payload(dm("UBOT", "a bot", ts(5), { bot_id: "B9" })),
      k.fake.payload(dm("UJARVIS", "Jarvis itself", ts(6))),
      k.fake.payload(dm("USLACKBOT", "Slackbot", ts(7))),
      k.fake.payload(dm("UANA", "", ts(8), { subtype: "message_changed" })),
      k.fake.payload(dm("UANA", "joined", ts(9), { subtype: "channel_join" })),
      // A channel message, which the bot doesn't subscribe to.
      k.fake.payload(dm("UANA", "in #general", ts(10), { channel: "C1", channel_type: "channel" })),
      // An event for a user's install of the app, not the bot's: your DM with someone else.
      k.fake.payload(dm("UANA", "to you, not Jarvis", ts(11)), {
        authorizations: [{ team_id: "T1", user_id: "UME", is_bot: false }],
      }),
    ];
    const kept = [
      k.fake.payload(dm("UANA", "a file", ts(12), { subtype: "file_share", files: [{}] })),
      k.fake.payload(
        dm("UANA", "a broadcast", ts(13), { subtype: "thread_broadcast", thread_ts: ts(1) }),
      ),
    ];
    for (const p of [...dropped, ...kept]) await k.fake.acked(k.fake.send(p));
    expect((await k.rows()).map((r) => [r.text, r.subtype])).toEqual([
      ["a file", "file_share"],
      ["a broadcast", "thread_broadcast"],
    ]);
  });
});
