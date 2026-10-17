// Catching up (D62): what was said to Jarvis while nothing listened is read back once, the first
// connect starts at now, and marks move only past what was read.
import { randomBytes } from "node:crypto";
import { PRINCIPAL } from "@hearth/core";
import { entity, slackBot, slackChannel, slackInbound, slackThread } from "@hearth/db";
import { newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../../browser/vault.ts";
import { ALL_MODULES } from "../../index.ts";
import { INSTALL_SERVICE } from "../../install.ts";
import { SLACK_SERVICE } from "../api.ts";
import { FakeSlack } from "../fake.ts";
import { SLACK_BOT_SERVICE } from "./api.ts";
import { catchUp } from "./catchup.ts";
import { slackTs } from "./socket.ts";

let t: TestKernel;
let s: FakeSlack;
const services = { service: <T>(name: string) => t.kernel.services[name] as T };

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  s = new FakeSlack();
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[SLACK_BOT_SERVICE] = s.botApi();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  t.kernel.services[INSTALL_SERVICE] = { id: () => "install-live" };
  for (const [name, input] of [
    ["slack.connect", { token: s.token }],
    ["slack.bot_connect", { botToken: s.bot.token, appToken: s.bot.appToken }],
  ] as const) {
    const res = await t.kernel.execute(name, input, ownerCaller());
    if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  }
  s.ims.set("UANA", "DUANA");
  s.ims.set("UBEN", "DUBEN");
  // Messages from here on are after the first connect.
  s.clock = Math.floor(t.clock.now().getTime() / 1000) + 10;
});
afterEach(() => t.destroy());

const round = () => catchUp(t.tdb.db, services, "T1", t.clock.now());
const bot = async () => (await t.tdb.db.select().from(slackBot))[0]!;
const texts = async () =>
  (await t.tdb.db.select().from(slackInbound).orderBy(slackInbound.ts)).map((r) => r.text);
const turnOn = (id: string, name: string) =>
  t.tdb.db
    .insert(slackChannel)
    .values({ id, teamId: "T1", name, kind: "channel", jarvisTier: "relay" });
const jarvisSays = (channel: string, text: string, thread?: string) =>
  s.post(channel, "UJARVIS", text, thread, { botId: "BJARVIS" });

describe("catching up", () => {
  it("starts at now on the first connect, importing nothing said before", async () => {
    s.clock -= 3600;
    s.post("DUANA", "UANA", "an hour ago");
    s.post("C1", "UBEN", "<@UJARVIS> an hour ago too");
    await turnOn("C1", "general");
    expect(await round()).toEqual({ first: true, dms: 0, mentions: 0, errors: [] });
    const now = slackTs(t.clock.now());
    expect(await bot()).toMatchObject({ listenFrom: now, mentionsTs: now });
    expect(await round()).toEqual({ first: false, dms: 0, mentions: 0, errors: [] });
    expect(await texts()).toEqual([]);
  });

  it("finds 3 DMs and 1 thread mention after half an hour down, once each", async () => {
    await round();
    await turnOn("C1", "general");
    await turnOn("C3", "eng");
    s.post("DUANA", "UANA", "are you there?");
    jarvisSays("DUANA", "I'm here.");
    s.post("DUANA", "UANA", "great");
    s.post("DUBEN", "UBEN", "ping");
    const top = s.post("C1", "UCAL", "standup notes");
    s.post("C1", "UCAL", "<@UJARVIS> can you pass this on?", top);
    // Not in a channel that's on, from a bot, or Jarvis's own: none of these.
    s.post("C2", "UCAL", "<@UJARVIS> over here");
    s.post("C3", "UBOT", "<@UJARVIS> beep", undefined, { botId: "B9" });
    jarvisSays("C3", "Thanks <@UJARVIS>");
    t.clock.advance(30 * 60_000);

    expect(await round()).toEqual({ first: false, dms: 3, mentions: 1, errors: [] });
    expect(await round()).toEqual({ first: false, dms: 0, mentions: 0, errors: [] });
    expect(await texts()).toEqual([
      "are you there?",
      "great",
      "ping",
      "<@UJARVIS> can you pass this on?",
    ]);
    const thread = await t.tdb.db.select().from(slackInbound);
    expect(thread.find((r) => r.channelId === "C1")).toMatchObject({
      threadTs: top,
      channelType: "channel",
      source: "catchup",
      userId: "UCAL",
    });
  });

  it("leaves a mark where it couldn't read, and reads on from it next time", async () => {
    await round();
    await turnOn("C1", "general");
    s.post("DUANA", "UANA", "first");
    s.post("DUBEN", "UBEN", "second");
    s.post("C1", "UCAL", "<@UJARVIS> third");
    const marked = (await bot()).mentionsTs;
    s.failCalls.set("bot history DUANA", "internal_error");
    s.failCalls.set("search <@UJARVIS>", "ratelimited");
    const cut = await round();
    expect(cut).toMatchObject({ dms: 1, mentions: 0 });
    expect(cut.errors).toHaveLength(2);
    expect((await bot()).mentionsTs).toBe(marked);

    s.failCalls.clear();
    expect(await round()).toMatchObject({ dms: 1, mentions: 1, errors: [] });
    expect(await texts()).toEqual(["first", "second", "<@UJARVIS> third"]);
  });

  it("reads every page of a busy channel's mentions", async () => {
    await round();
    await turnOn("C1", "general");
    for (let i = 0; i < 60; i++) s.post("C1", "UCAL", `<@UJARVIS> number ${i}`);
    expect(await round()).toMatchObject({ mentions: 60 });
    expect((await bot()).mentionsTs).toBe(`${s.clock - 1}.000100`);
  });

  it("moves the mentions mark to now while no channel is on, so turning one on later reads on from then", async () => {
    await round();
    s.post("C1", "UCAL", "<@UJARVIS> while it was off");
    t.clock.advance(10 * 60_000);
    await round();
    expect((await bot()).mentionsTs).toBe(slackTs(t.clock.now()));
    await turnOn("C1", "general");
    expect(await round()).toMatchObject({ mentions: 0 });
  });

  it("reads a DM on from its conversation's mark, and moves the mark past what it read", async () => {
    await round();
    const conversation = newId();
    await t.tdb.db.insert(entity).values({
      id: conversation,
      type: "conversation",
      createdBy: PRINCIPAL.system,
      updatedBy: PRINCIPAL.system,
    });
    await t.tdb.db
      .insert(slackThread)
      .values({ channelId: "DUME", teamId: "T1", conversationId: conversation, audience: "owner" });
    const mine = s.post("DUME", "UME", "remind me at 5");
    await round();
    const mark = async () => (await t.tdb.db.select().from(slackThread))[0]!.mark;
    expect(await mark()).toBe(mine);
    const reply = jarvisSays("DUME", "Got it, it's in Nook.");
    await round();
    expect(await mark()).toBe(reply);
    expect(await texts()).toEqual(["remind me at 5"]);
  });
});
