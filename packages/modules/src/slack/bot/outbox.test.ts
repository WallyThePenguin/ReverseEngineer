// The outbox's sender (D62): each post goes out once, at Slack's pace, and what doesn't go is
// either tried again, read back, or failed and told to you. A post Slack took without answering
// is found by its metadata, and only on a post of our own bot's.
import { slackBot } from "@hearth/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SendTest, sendTest } from "./outbox-testing.ts";
import { claimNext, OUTBOX_EXPIRES_MS, PACE_MS, SENDING_STALE_MS } from "./queue.ts";

let k: SendTest;
beforeEach(async () => {
  k = await sendTest();
});
afterEach(() => k.t.destroy());

const texts = () => k.s.posts.map((p) => p.text);
const tsIn = (channel: string) => k.s.messages.get(channel)?.at(-1)?.ts;
/** A worker that died after marking a post `sending`, before or after Slack had it. */
const crash = () => claimNext(k.t.tdb.db, "T1", k.t.clock.now());

describe("sending Jarvis's posts", () => {
  it("posts a DM in the bot's DM with them, filtered, carrying its row's id, once", async () => {
    const row = await k.queue({ channelId: "USAM", text: "Hi <!channel>, **done**" });
    expect(await k.round()).toMatchObject({ sent: 1, held: false, more: false });
    expect(k.s.posts).toEqual([
      { channel: "DUSAM", text: "Hi &lt;!channel&gt;, *done*", outboxId: row.id },
    ]);
    expect((await k.rows())[0]).toMatchObject({
      state: "sent",
      channelId: "USAM",
      sentTs: tsIn("DUSAM"),
      attempts: 1,
      error: null,
    });
    expect(await k.round()).toMatchObject({ sent: 0 });
    expect(k.s.posts).toHaveLength(1);
  });

  it("doesn't post again when Slack took it but the answer never came (D61)", async () => {
    await k.queue({ channelId: "USAM", text: "The build is fixed" });
    k.s.postFaults.push("lost_answer");
    expect(await k.round()).toMatchObject({ sent: 0, unsure: 1 });
    expect((await k.rows())[0]).toMatchObject({ state: "sending" });
    // Left alone until it's been a minute.
    expect(await k.round()).toMatchObject({ sent: 0, unsure: 0 });
    k.t.clock.advance(SENDING_STALE_MS);
    expect(await k.round()).toMatchObject({ sent: 1 });
    // Read back from the bot's DM with its own token, found, and not posted twice.
    expect(k.s.calls).toContain("bot readback DUSAM");
    expect(texts()).toEqual(["The build is fixed"]);
    expect((await k.rows())[0]).toMatchObject({
      state: "sent",
      sentTs: tsIn("DUSAM"),
      attempts: 2,
    });
  });

  it("takes no other bot's post for its own, whatever metadata it carries", async () => {
    const row = await k.queue({ channelId: "CGEN", text: "Standup moved to 10" });
    k.s.postFaults.push("no_answer");
    expect(await k.round()).toMatchObject({ unsure: 1 });
    const other = k.s.post("CGEN", "UOTHER", "Standup moved to 10", undefined, {
      botId: "BOTHER",
      outboxId: row.id,
    });
    k.t.clock.advance(SENDING_STALE_MS);
    expect(await k.round()).toMatchObject({ sent: 1 });
    // A channel is read back with your own token, which only reads.
    expect(k.s.calls).toContain("readback CGEN");
    expect(k.s.posts).toEqual([{ channel: "CGEN", text: "Standup moved to 10", outboxId: row.id }]);
    const [done] = await k.rows();
    expect(done!.sentTs).toBe(tsIn("CGEN"));
    expect(done!.sentTs).not.toBe(other);
  });

  it("recovers a post a crash left `sending`: posted if it didn't go, not if it did", async () => {
    await k.queue({ channelId: "CGEN", text: "never reached Slack" });
    expect((await crash()).kind).toBe("row");
    expect(await k.round()).toMatchObject({ sent: 0 });
    k.t.clock.advance(SENDING_STALE_MS);
    expect(await k.round()).toMatchObject({ sent: 1 });
    expect(texts()).toEqual(["never reached Slack"]);

    const row = await k.queue({ channelId: "USAM", text: "reached Slack" });
    expect((await crash()).kind).toBe("row");
    await k.s
      .botApi()
      .post(k.s.bot.token, { channel: "USAM", text: "reached Slack", outboxId: row.id });
    k.t.clock.advance(SENDING_STALE_MS);
    expect(await k.round()).toMatchObject({ sent: 1 });
    expect(texts()).toEqual(["never reached Slack", "reached Slack"]);
    expect((await k.rows())[1]).toMatchObject({ state: "sent", sentTs: tsIn("DUSAM") });
  });

  it("says a channel post may not have gone out when it can't be read back, and leaves it", async () => {
    await k.queue({ channelId: "CGEN", text: "Hello all" });
    k.s.postFaults.push("lost_answer");
    await k.round();
    k.s.failCalls.set("readback CGEN", "channel_not_found");
    k.t.clock.advance(SENDING_STALE_MS);
    expect(await k.round()).toMatchObject({ unknown: 1, sent: 0 });
    expect(k.s.posts).toHaveLength(1);
    expect((await k.rows())[0]).toMatchObject({ state: "unknown" });
    expect(await k.told()).toEqual([
      {
        title: "Jarvis's Slack message to #general may not have gone out",
        body: "You aren't in that channel, so Hearth couldn't look.\n\nHello all",
      },
    ]);
  });

  it("waits as long as Slack asks when told to slow down, and so does everything after it", async () => {
    await k.queue({ channelId: "CGEN", text: "one" });
    k.t.clock.advance(1);
    await k.queue({ channelId: "USAM", text: "two" });
    k.s.postFaults.push({ code: "ratelimited", retryAfter: 30 });
    expect(await k.round()).toMatchObject({ sent: 0, waiting: 1 });
    k.t.clock.advance(29_000);
    expect(await k.round()).toMatchObject({ sent: 0 });
    expect(k.s.posts).toEqual([]);
    k.t.clock.advance(1_000);
    expect(await k.round()).toMatchObject({ sent: 2 });
    expect(texts()).toEqual(["one", "two"]);
  });

  it("posts at most once a second in one place", async () => {
    for (const text of ["a", "b", "c"]) {
      await k.queue({ channelId: "CGEN", text });
      k.t.clock.advance(1);
    }
    await k.queue({ channelId: "USAM", text: "d" });
    expect(await k.round()).toMatchObject({ sent: 2, more: true });
    expect(texts()).toEqual(["a", "d"]);
    expect(await k.round()).toMatchObject({ sent: 0, more: true });
    k.t.clock.advance(PACE_MS);
    expect(await k.round()).toMatchObject({ sent: 1, more: true });
    k.t.clock.advance(PACE_MS);
    expect(await k.round()).toMatchObject({ sent: 1, more: false });
    expect(texts()).toEqual(["a", "d", "b", "c"]);
  });

  it("and at most 20 a minute in all", async () => {
    for (let i = 0; i < 22; i++) {
      k.s.channel(`C${i}`, `c${i}`, ["UJARVIS"]);
      await k.queue({ channelId: `C${i}`, text: `${i}` });
    }
    expect(await k.round()).toMatchObject({ sent: 20 });
    expect(await k.round()).toMatchObject({ sent: 0, more: true });
    k.t.clock.advance(60_000);
    expect(await k.round()).toMatchObject({ sent: 2, more: false });
  });

  it("fails a post Slack won't take, tells you, and doesn't try it again", async () => {
    await k.queue({ channelId: "CRAND", text: "Lunch?" });
    expect(await k.round()).toMatchObject({ failed: 1 });
    expect((await k.rows())[0]).toMatchObject({
      state: "failed",
      error: "Slack said not_in_channel.",
      finishedAt: k.t.clock.now(),
    });
    expect(await k.told()).toEqual([
      {
        title: "Jarvis's Slack message to #random didn't go out",
        body: "Slack said not_in_channel.\n\nLunch?",
      },
    ]);
    expect(await k.round()).toMatchObject({ failed: 0, sent: 0 });
    expect(k.s.posts).toEqual([]);
  });

  it("holds everything while Slack has the bot revoked; a day on, it expires and you're told", async () => {
    await k.queue({ channelId: "USAM", text: "See you at 3" });
    k.s.postFaults.push({ code: "token_revoked" });
    expect(await k.round()).toMatchObject({ held: true, sent: 0 });
    expect((await k.t.tdb.db.select().from(slackBot))[0]!.syncState).toBe("revoked");
    expect((await k.rows())[0]).toMatchObject({ state: "queued" });
    k.t.clock.advance(OUTBOX_EXPIRES_MS - 1);
    expect(await k.round()).toMatchObject({ held: true, sent: 0, expired: 0 });
    k.t.clock.advance(1);
    expect(await k.round()).toMatchObject({ held: true, expired: 1 });
    expect((await k.rows())[0]).toMatchObject({ state: "expired" });
    expect(k.s.posts).toEqual([]);
    expect(await k.told()).toEqual([
      {
        title: "Jarvis's Slack message to Sam Lee didn't go out",
        body: "It waited a day: Jarvis's Slack bot couldn't post.\n\nSee you at 3",
      },
    ]);
  });
});
