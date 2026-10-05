// @Jarvis in your Slack's channels (D62). Only a channel you're in, with no guests and no other
// org, can be on, checked when you turn it on and every hour after; one that fails is turned off
// and you're told. Everyone in a channel reads the answer, so a turn there gets the lower of the
// member's tier and the channel's (yours too), only the answers for everyone, and the thread so
// far as untrusted data. Anywhere Jarvis doesn't answer, the member hears so once a day.
import { approval, notification, slackChannel, slackInbound } from "@hearth/db";
import { integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { storeInbound } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemberTest, memberTest, person, SAM } from "./member-testing.ts";

let t: MemberTest;
const slack = integrationCaller("slack");
const EVERYONE = ["UME", SAM, "UJARVIS"];

beforeEach(async () => {
  t = await memberTest();
  // Channels as your own token reads them in, and as Slack describes them.
  const rows: (typeof slackChannel.$inferInsert)[] = [
    { id: "CLAUNCH", teamId: "T1", name: "launch", kind: "channel" },
    { id: "CRANDOM", teamId: "T1", name: "random", kind: "channel" },
    { id: "CSHARED", teamId: "T1", name: "acme-partners", kind: "channel" },
    { id: "CGUEST", teamId: "T1", name: "with-contractor", kind: "channel" },
    { id: "CNOBOT", teamId: "T1", name: "quiet", kind: "channel" },
    { id: "GMPIM", teamId: "T1", name: "mpdm-ana--sam--bo", kind: "group" },
  ];
  await t.h.tdb.db.insert(slackChannel).values(rows);
  t.s.users.set("UGUEST", person("UGUEST", { realName: "Gil Guest", guest: true }));
  t.s.channel("CLAUNCH", "launch", [...EVERYONE]);
  t.s.channel("CRANDOM", "random", [...EVERYONE]);
  t.s.channel("CSHARED", "acme-partners", [...EVERYONE], { shared: true });
  t.s.channel("CGUEST", "with-contractor", [...EVERYONE, "UGUEST"]);
  t.s.channel("CNOBOT", "quiet", ["UME", SAM]);
});
afterEach(() => t.h.destroy());

/** Someone @mentions Jarvis in a channel, as the socket stores it. Returns its ts. */
async function mention(user: string, channel: string, text: string, threadTs?: string) {
  const ts = t.s.post(channel, user, `<@UJARVIS> ${text}`, threadTs);
  await storeInbound(t.h.tdb.db, [
    {
      channelId: channel,
      ts,
      teamId: "T1",
      userId: user,
      threadTs: threadTs ?? null,
      channelType: channel.startsWith("G") ? "group" : "channel",
      subtype: null,
      text: `<@UJARVIS> ${text}`,
      source: "event",
      receivedAt: t.h.clock.now(),
    },
  ]);
  return ts;
}
const turnOn = (channel: string, tier = "relay", replies?: string) =>
  t.h.kernel.execute(
    "slack.channel_set",
    { channel, tier, ...(replies ? { replies } : {}) },
    ownerCaller(),
  );

describe("turning a channel on", () => {
  it("only when it's yours alone: not Slack Connect, a guest's, a group DM, or one Jarvis isn't in", async () => {
    expect(await turnOn("CLAUNCH")).toMatchObject({ status: "ok", result: { tier: "relay" } });
    const refused = async (channel: string) => {
      const res = await turnOn(channel);
      expect(res.status).toBe("error");
      return (res as { message: string }).message;
    };
    expect(await refused("CSHARED")).toContain("shared with another org (Slack Connect)");
    expect(await refused("CGUEST")).toContain("A guest is in it.");
    expect(await refused("GMPIM")).toContain("never in a group DM or a DM");
    expect(await refused("CNOBOT")).toContain("invite @Jarvis there first");
    // Only you choose where Jarvis talks.
    const jarvis = await t.h.kernel.execute(
      "slack.channel_set",
      { channel: "CRANDOM", tier: "relay" },
      jarvisCaller("owner"),
    );
    expect(jarvis.status).toBe("denied");
  });

  it("turns it off at the next hourly check once a guest joins, and tells you", async () => {
    await turnOn("CLAUNCH");
    t.h.clock.advance(30 * 60_000);
    expect(await t.ok("slack.check_channels", {}, slack)).toEqual({ checked: 0, off: 0 });
    t.s.channelFacts.get("CLAUNCH")!.members.push("UGUEST");
    t.h.clock.advance(31 * 60_000);
    expect(await t.ok("slack.check_channels", {}, slack)).toEqual({ checked: 1, off: 1 });
    const [ch] = await t.h.tdb.db.select().from(slackChannel).where(eq(slackChannel.id, "CLAUNCH"));
    expect(ch!.jarvisTier).toBe("off");
    const [card] = await t.cards("slack.channel_off");
    expect(card).toMatchObject({ title: "Jarvis stopped answering in #launch" });
    expect(card!.body).toContain("A guest is in it.");
    // From then on, an @mention there gets the note, not a turn.
    await mention(SAM, "CLAUNCH", "are we shipping?");
    await t.tick();
    expect(await t.turns()).toEqual([]);
  });

  it("waits for its hourly check before a turn in a channel checked over an hour ago", async () => {
    await turnOn("CLAUNCH");
    t.h.clock.advance(61 * 60_000);
    await mention(SAM, "CLAUNCH", "are we shipping?");
    await t.tick();
    expect(await t.turns()).toEqual([]);
    await t.ok("slack.check_channels", {}, slack);
    await t.tick();
    expect(await t.turns()).toHaveLength(1);
  });
});

describe("a turn in a channel's thread", () => {
  /** What tools Sam's (or your) turn was offered for an @mention in #launch. */
  async function offered(user = SAM) {
    let tools: string[] = [];
    t.h.brain.next((req) => {
      tools = req.tools.map((x) => x.name);
      return [{ say: "Hi." }];
    });
    await mention(user, "CLAUNCH", "when is Ana free?");
    await t.tick();
    await t.drain();
    return tools;
  }

  it("gets no free time unless both the member and the channel share it", async () => {
    await t.setSam({ tier: "schedule" });
    await turnOn("CLAUNCH", "relay");
    expect(await offered()).toEqual(["member_leave_message"]);
    await t.setSam({ tier: "relay" });
    await turnOn("CLAUNCH", "schedule");
    expect(await offered()).toEqual(["member_leave_message"]);
    await t.setSam({ tier: "schedule" });
    expect(await offered()).toEqual([
      "member_free_time",
      "member_leave_message",
      "member_request_meeting",
    ]);
  });

  it("sees only the answers for everyone, and the thread so far as untrusted data", async () => {
    await t.ok("slack.answer_save", { title: "Hours", body: "EVERYONE-ANSWER", users: null });
    await t.ok("slack.answer_save", { title: "Sam", body: "SAM-ONLY-ANSWER", users: [SAM] });
    await turnOn("CLAUNCH");
    t.s.users.set("UBO", person("UBO", { realName: "Bo Ray" }));
    const root = t.s.post("CLAUNCH", "UBO", "Who's on call this weekend? CANARY-THREAD");
    t.h.brain.next([{ say: "Bo is, I think." }]);
    await mention(SAM, "CLAUNCH", "do you know?", root);
    await t.tick();
    await t.drain();
    const req = t.h.brain.requests.at(-1)!;
    expect(req.system).toContain("EVERYONE-ANSWER");
    expect(req.system).not.toContain("SAM-ONLY-ANSWER");
    expect(req.system).toContain("Everyone in #launch reads your answer");
    // The thread, read with your own token, wrapped like the member's own words.
    expect(t.s.calls).toContain(`thread CLAUNCH ${root}`);
    const wrapped = req.prompt.slice(req.prompt.indexOf('<untrusted source="slack:CLAUNCH">'));
    expect(wrapped.slice(0, wrapped.indexOf("</untrusted>"))).toContain("CANARY-THREAD");
    expect(req.prompt).toContain('<untrusted source="slack:USAM">');
    // Channel replies wait for your yes, and the card says the channel reads it.
    const [held] = await t.h.tdb.db
      .select()
      .from(approval)
      .where(eq(approval.action, "slack.reply"));
    expect(held!.summary).toContain("a thread in #launch, which everyone there reads");
  });

  it("is yours at the channel's tier when you @mention Jarvis there", async () => {
    await turnOn("CLAUNCH", "relay");
    expect(await offered("UME")).toEqual(["member_leave_message"]);
    const [turn] = await t.turns();
    expect(turn!.context).toMatchObject({ member: "member:slack:T1:UME", channel: "CLAUNCH" });
    expect(t.h.brain.requests.at(-1)!.system).toContain("Ana asked you there, but in front of");
    await turnOn("CLAUNCH", "schedule");
    expect(await offered("UME")).toContain("member_free_time");
  });
});

describe("where Jarvis doesn't answer", () => {
  it("tells the member once a day in each channel, seen only by them", async () => {
    await mention(SAM, "CRANDOM", "hello?");
    await mention(SAM, "CRANDOM", "anyone?");
    await mention(SAM, "GMPIM", "hi Jarvis");
    await t.tick();
    await t.send();
    const notes = t.s.posts.filter((p) => p.ephemeralTo === SAM);
    expect(notes.map((p) => p.channel)).toEqual(["CRANDOM", "GMPIM"]);
    expect(notes.every((p) => p.text === "I only answer in DMs here: message me directly.")).toBe(
      true,
    );
    expect(t.s.posts.filter((p) => !p.ephemeralTo)).toEqual([]);
    t.h.clock.advance(24 * 3_600_000);
    await mention(SAM, "CRANDOM", "hello again");
    await t.tick();
    await t.send();
    expect(t.s.posts.filter((p) => p.ephemeralTo === SAM)).toHaveLength(3);
    const settled = await t.h.tdb.db
      .select({ outcome: slackInbound.outcome })
      .from(slackInbound)
      .where(eq(slackInbound.userId, SAM));
    expect(new Set(settled.map((r) => r.outcome))).toEqual(new Set(["ignored:channel_off"]));
    expect(await t.turns()).toEqual([]);
    expect(
      await t.h.tdb.db.select().from(notification).where(eq(notification.kind, "slack.member")),
    ).toEqual([]);
  });
});
