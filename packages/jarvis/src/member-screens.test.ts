// What the screens show of Jarvis in your Slack (D62): its conversations with members, read-only,
// each with who and where, held replies and a pause you control; and the brief's one line about
// them, marked as outside content since it counts what other people wrote.
import { slackChannel } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemberTest, memberTest, SAM, SAM_DM } from "./member-testing.ts";

let t: MemberTest;
beforeEach(async () => {
  t = await memberTest();
});
afterEach(() => t.h.destroy());

interface Shown {
  id: string;
  place: "dm" | "channel";
  people: { id: string; name: string; tier: string; member: boolean }[];
  pausedUntil: string | null;
  waiting: number;
  heldReplies: number;
}

async function ask(text: string) {
  await t.write(SAM, text);
  await t.tick();
  await t.drain();
}

describe("the Slack screens", () => {
  it("list Jarvis's conversations with members: who, where, and what waits for you", async () => {
    t.h.brain.otherwise([{ say: "I'll pass that on." }]);
    await ask("Is Ana around?");
    await t.setSam({ replies: "review" });
    await ask("And tomorrow?");
    const [dm] = await t.ok<Shown[]>("slack.conversations");
    expect(dm).toMatchObject({
      place: "dm",
      people: [{ id: SAM, name: "Sam Lee", tier: "relay", member: true }],
      pausedUntil: null,
      heldReplies: 1,
    });
    expect(await t.ok<Shown>("slack.conversation", { id: dm!.id })).toMatchObject({ id: dm!.id });
    // Your own conversations aren't theirs, and aren't shown here.
    const mine = await t.ok<{ conversationId: string }>("chat.send", { text: "Hi" });
    const res = await t.h.kernel.execute(
      "slack.conversation",
      { id: mine.conversationId },
      ownerCaller(),
    );
    expect(res).toMatchObject({ status: "error", code: "not_found" });
    // Your everyday list has theirs too, marked, so each screen showing one shows it read-only.
    const listed = await t.ok<{ id: string; startedVia: string | null }[]>("conversation.list");
    expect(listed.find((c) => c.id === dm!.id)?.startedVia).toBe("slack_member");
    expect(listed.find((c) => c.id === mine.conversationId)?.startedVia).toBeNull();
    const got = await t.ok<{ conversation: { startedVia: string } }>("conversation.get", {
      id: dm!.id,
    });
    expect(got.conversation.startedVia).toBe("slack_member");
  });

  it("pause one conversation: what they write is passed on to you until you resume it", async () => {
    t.h.brain.otherwise([{ say: "Hello." }]);
    await ask("Hi");
    const [dm] = await t.ok<Shown[]>("slack.conversations");
    const paused = await t.ok<{ pausedUntil: string }>("slack.conversation_pause", {
      id: dm!.id,
      hours: 1,
    });
    expect(new Date(paused.pausedUntil).getTime()).toBe(t.h.clock.now().getTime() + 3_600_000);
    await ask("Are you there?");
    expect((await t.inbound()).map((r) => r.outcome)).toEqual(["answered", "relayed"]);
    await t.send();
    expect(t.s.posts.at(-1)).toMatchObject({
      channel: SAM_DM,
      text: "I'm paused at the moment, so I've passed your message on to Ana.",
    });
    await t.ok("slack.conversation_pause", { id: dm!.id, hours: 0 });
    await ask("Now?");
    expect((await t.inbound()).map((r) => r.outcome)).toEqual(["answered", "relayed", "answered"]);
    // Only you pause Jarvis.
    const jarvis = await t.h.kernel.execute(
      "slack.conversation_pause",
      { id: dm!.id, hours: 1 },
      { principal: "jarvis", kind: "agent", origin: "owner", via: "jarvis" },
    );
    expect(jarvis.status).toBe("denied");
  });

  it("put one line in the brief, marked as outside content", async () => {
    const since = t.h.clock.now();
    t.h.brain.otherwise([{ say: "Sure." }]);
    await ask("Is Ana around?");
    await ask("Thanks!");
    const sections = await t.h.engine.digest(since);
    const member = sections.find((s) => s.module === "member");
    expect(member?.items).toEqual([
      {
        bucket: "handled",
        text: "The Jarvis bot answered 2 Slack messages from 1 person.",
        outside: true,
      },
    ]);
  });

  it("show the channels Jarvis answers in, and when they were checked", async () => {
    await t.h.tdb.db
      .insert(slackChannel)
      .values({ id: "CLAUNCH", teamId: "T1", name: "launch", kind: "channel" });
    t.s.channel("CLAUNCH", "launch", ["UME", SAM, "UJARVIS"]);
    await t.ok("slack.channel_set", { channel: "CLAUNCH", tier: "relay" });
    const channels =
      await t.ok<{ id: string; jarvisTier: string; jarvisCheckedAt: unknown }[]>("slack.channels");
    const launch = channels.find((c) => c.id === "CLAUNCH");
    expect(launch).toMatchObject({ jarvisTier: "relay", jarvisReplies: "review" });
    expect(launch!.jarvisCheckedAt).toBeTruthy();
  });
});
