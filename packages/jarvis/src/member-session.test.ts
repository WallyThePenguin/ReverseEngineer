// A member's DM and its agent session (D62): an answer that didn't go is never carried on from,
// however it didn't go; what Jarvis said there is only what went out, as it went; and a change
// you make while a turn answers ends the session, even when the answer goes on its own.
import { approval, conversation } from "@hearth/db";
import { ownerCaller, setSetting } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MemberTest, memberTest, SAM } from "./member-testing.ts";

let t: MemberTest;
beforeEach(async () => {
  t = await memberTest();
});
afterEach(() => t.h.destroy());

async function ask(text: string, answer: string) {
  t.h.brain.next([{ say: answer }]);
  await t.write(SAM, text);
  await t.tick();
  await t.drain();
}
async function meanwhile(change: () => Promise<unknown>, answer: string) {
  t.h.brain.next(async () => {
    await change();
    return [{ say: answer }];
  });
  await t.write(SAM, "Can we talk Thursday?");
  await t.tick();
  await t.drain();
}
const session = async () => {
  const [c] = await t.h.tdb.db.select().from(conversation);
  return c!.agentSessionId;
};
const pause = (on: boolean) => setSetting(t.h.tdb.db, "jarvis.paused", on);
const request = (n: number) => t.h.brain.requests[n]!;

describe("an answer that didn't go", () => {
  it("isn't carried on from after the outbox stopped it, even if the session was kept", async () => {
    await ask("Is the budget approved?", "Yes, it's approved.");
    expect(await session()).toBe("scripted-session");
    // Paused before it went: it fails at the last check, and its DM's session goes with it.
    await pause(true);
    await t.send();
    expect(await t.outbox()).toMatchObject([{ state: "failed" }]);
    expect(await session()).toBeNull();
    await pause(false);
    // Kept anyway (a turn that ended just after, say): the next turn still starts afresh.
    await t.h.tdb.db.update(conversation).set({ agentSessionId: "scripted-session" });
    t.h.clock.advance(60_000);
    await ask("And the new hire?", "I'll pass that on.");
    expect(request(1).sessionId).toBeNull();
    expect(request(1).prompt).toContain("Is the budget approved?");
    expect(request(1).prompt).not.toContain("Yes, it's approved.");
  });

  it("isn't carried on from once you let the bot go before it went", async () => {
    await ask("Hi", "Hello Sam.");
    await t.ok("slack.bot_disconnect");
    expect(await t.outbox()).toMatchObject([{ state: "failed" }]);
    expect(await session()).toBeNull();
  });

  it("isn't brought back by a turn that was answering when it failed", async () => {
    await ask("Hi", "Hello Sam.");
    t.h.clock.advance(60_000);
    // While the next turn answers, the first answer fails on its way out.
    await meanwhile(async () => {
      await pause(true);
      await t.send();
      await pause(false);
    }, "Thursday works.");
    expect(request(1).sessionId).toBe("scripted-session");
    expect(await session()).toBeNull();
    t.h.clock.advance(60_000);
    await ask("At 3?", "3 is fine.");
    expect(request(2).sessionId).toBeNull();
    expect(request(2).prompt).toContain("Thursday works.");
    expect(request(2).prompt).not.toContain("Hello Sam.");
  });
});

it("puts to the next session only what went out, not what Jarvis wrote on the way", async () => {
  await t.setSam({ tier: "schedule" });
  t.h.brain.next([
    { say: "Ana is free Tue 3-5 and Wed 9-12; I'll offer the earliest." },
    { say: "Ana's free Tuesday at 3." },
    { outOfSteps: 8 },
  ]);
  await t.write(SAM, "When is Ana free?");
  await t.tick();
  await t.drain();
  await t.send();
  expect(t.s.posts.map((p) => p.text)).toEqual(["Ana's free Tuesday at 3."]);
  // Lowered to relay: the next turn starts afresh, and mustn't learn Wednesday from the recap.
  await t.setSam({ tier: "relay" });
  await ask("And Wednesday?", "I'll pass that on.");
  expect(request(1).sessionId).toBeNull();
  expect(request(1).prompt).toContain("Ana's free Tuesday at 3.");
  expect(request(1).prompt).not.toContain("Wed 9-12");
});

describe("a change while it answers", () => {
  it("ends the session even when Jarvis was paused too, and you then said yes", async () => {
    await t.setSam({ tier: "schedule" });
    await meanwhile(async () => {
      await pause(true);
      await t.setSam({ tier: "relay" });
    }, "Ana is free Thursday at 3.");
    await pause(false);
    const [held] = await t.h.tdb.db
      .select()
      .from(approval)
      .where(eq(approval.action, "slack.reply"));
    expect(await t.h.kernel.decideApproval(held!.id, "approve", ownerCaller())).toMatchObject({
      status: "ok",
    });
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual(["Ana is free Thursday at 3."]);
    await ask("And Friday?", "I'll pass that on.");
    // Not the session with schedule's tool results in it.
    expect(request(1).sessionId).toBeNull();
  });

  it("ends the session when the answer still goes on its own", async () => {
    await meanwhile(() => t.setSam({ tier: "schedule" }), "Thursday works.");
    await t.send();
    expect(t.s.posts.map((p) => p.text)).toEqual(["Thursday works."]);
    expect(await session()).toBeNull();
    t.h.clock.advance(60_000);
    await ask("At 3?", "3 is fine.");
    expect(request(1).sessionId).toBeNull();
  });
});
