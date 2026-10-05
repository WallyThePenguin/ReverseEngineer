// Connecting Jarvis's own Slack bot (D62): only the right app's tokens, in your workspace, with
// the manifest's scopes, get in; they're sealed apart and never written anywhere readable; and
// the switch that lets members' DM replies go out on their own starts on, once.
import { randomBytes } from "node:crypto";
import { memberPrincipal, PRINCIPAL } from "@hearth/core";
import { audit, event, principal, slackBot, slackOutbox, standingRule } from "@hearth/db";
import { type Caller, jarvisCaller, memberCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../../browser/vault.ts";
import { ALL_MODULES } from "../../index.ts";
import { INSTALL_SERVICE } from "../../install.ts";
import { SLACK_SERVICE } from "../api.ts";
import { FakeSlack } from "../fake.ts";
import { SLACK_BOT_SERVICE } from "./api.ts";
import { BOT_SCOPES, USER_SCOPES } from "./manifest.ts";
import { openBotToken } from "./tokens.ts";

let t: TestKernel;
let s: FakeSlack;
/** The kernel's services, as the worker hands them to openBotToken. */
const services = { service: <T>(name: string) => t.kernel.services[name] as T };
const install = (id: string) => {
  t.kernel.services[INSTALL_SERVICE] = { id: () => id };
};

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  s = new FakeSlack();
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[SLACK_BOT_SERVICE] = s.botApi();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  install("install-live");
  await ok("slack.connect", { token: s.token });
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const tokens = () => ({ botToken: s.bot.token, appToken: s.bot.appToken });
const connect = (input: unknown = tokens()) =>
  ok<{ team: string; botUser: string; warnings: string[] }>("slack.bot_connect", input);
const refused = async (input: unknown = tokens()) => {
  const res = await t.kernel.execute("slack.bot_connect", input, ownerCaller());
  expect(res.status).toBe("error");
  expect(await t.tdb.db.select().from(slackBot)).toEqual([]);
  return (res as { message: string }).message;
};
const bot = async () => (await t.tdb.db.select().from(slackBot))[0]!;
const autoRule = async () =>
  (await t.tdb.db.select().from(standingRule)).filter(
    (r) => r.action === "slack.reply" && r.principal === memberPrincipal("T1", "*"),
  );

describe("connecting Jarvis's Slack bot", () => {
  it("seals each token under its own name, opens the bot's DM with you, and records this install", async () => {
    expect(await connect()).toEqual({ team: "Acme", botUser: "UJARVIS", warnings: [] });
    const row = await bot();
    expect(row).toMatchObject({
      teamId: "T1",
      appId: "A0C0RPY4WKV",
      botUserId: "UJARVIS",
      botId: "BJARVIS",
      ownerIm: "DUME",
      installId: "install-live",
      syncState: "ok",
    });
    expect(s.ims.get("UME")).toBe("DUME");
    expect(openBotToken(services, row, "bot")).toBe(s.bot.token);
    expect(openBotToken(services, row, "app")).toBe(s.bot.appToken);
    // A token moved into the other's column won't open.
    const swapped = { ...row, botToken: row.appToken, appToken: row.botToken };
    expect(() => openBotToken(services, swapped, "bot")).toThrow(/can't be opened/);
    expect(() => openBotToken(services, swapped, "app")).toThrow(/can't be opened/);

    const status = await ok<Record<string, unknown>>("slack.bot_status");
    expect(status).toMatchObject({
      connected: true,
      botUser: "UJARVIS",
      state: "ok",
      listensHere: true,
      membersOn: false,
      answersOnOwn: true,
    });
    // Another copy of Hearth, on a restored database, isn't the one that listens.
    install("install-dev");
    expect(await ok("slack.bot_status")).toMatchObject({ listensHere: false });
  });

  it("never writes a token where it can be read back: the audit log, events or status", async () => {
    await connect();
    await ok("slack.bot_replace_tokens", tokens());
    // A refused try is audited too, with its input.
    s.bot.teamId = "T2";
    expect((await t.kernel.execute("slack.bot_connect", tokens(), ownerCaller())).status).toBe(
      "error",
    );
    const written = JSON.stringify([
      await t.tdb.db.select().from(audit),
      await t.tdb.db.select().from(event),
      await t.tdb.db.select().from(slackBot),
      await ok("slack.bot_status"),
    ]);
    expect(written).toContain("slack.bot_connect");
    for (const secret of [s.bot.token, s.bot.appToken, "1111-apptest", "bottest"])
      expect(written).not.toContain(secret);
  });

  it("refuses the wrong workspace, the wrong app, and your own token as the bot's", async () => {
    // The app token names its app: refused before anything is sent.
    expect(await refused({ ...tokens(), appToken: "xapp-1-A0OTHERAPP1-1111-apptest" })).toMatch(
      /for app A0OTHERAPP1, not Jarvis's \(A0C0RPY4WKV\)/,
    );
    // Your own token where the bot's goes, by name, and nothing sent either.
    expect(await refused({ ...tokens(), botToken: s.token })).toMatch(
      /your own user token \(xoxp-\)/,
    );
    expect(await refused({ ...tokens(), appToken: s.bot.token })).toMatch(/starts with xapp-/);
    expect(s.calls.filter((c) => c.startsWith("bot "))).toEqual([]);

    s.bot.teamId = "T2";
    expect(await refused()).toMatch(/another Slack workspace, not Acme/);
    s.bot.teamId = "T1";
    // The token says it's Jarvis's app, but the socket's hello names another.
    s.bot.helloApp = "A0OTHERAPP1";
    expect(await refused()).toMatch(/socket is for app A0OTHERAPP1/);
    s.bot.helloApp = "A0C0RPY4WKV";
    s.bot.appScopes = ["authorizations:read"];
    expect(await refused()).toMatch(/needs the connections:write scope/);
  });

  it("refuses a missing scope on either token, and warns about the bot's extras but not your kept write scopes", async () => {
    s.bot.scopes = BOT_SCOPES.filter((x) => x !== "im:write");
    expect(await refused()).toMatch(/bot token is missing im:write/);
    s.bot.scopes = [...BOT_SCOPES];
    s.scopes = USER_SCOPES.filter((x) => x !== "search:read");
    expect(await refused()).toMatch(/Your own Slack token is missing search:read/);

    // Your app keeps chat:write, im:write and reactions:write for your own token: no warning.
    s.scopes = [...USER_SCOPES, "chat:write", "im:write", "reactions:write"];
    s.bot.scopes = [...BOT_SCOPES, "channels:history", "users:read"];
    const { warnings } = await connect();
    expect(warnings).toEqual([
      expect.stringMatching(
        /^The bot has scopes Hearth doesn't use: channels:history, users:read\./,
      ),
    ]);
  });

  it("is for you alone: not Jarvis, and not a member", async () => {
    for (const caller of [jarvisCaller("owner"), memberCaller("T1", "U1")])
      for (const name of [
        "slack.bot_connect",
        "slack.bot_replace_tokens",
        "slack.bot_disconnect",
        "slack.bot_status",
        "slack.bot_settings",
      ])
        expect((await t.kernel.execute(name, tokens(), caller)).status).toBe("denied");
    expect(await t.tdb.db.select().from(slackBot)).toEqual([]);
  });
});

describe("the bot afterwards", () => {
  it("takes new tokens, records this install, and starts its health over", async () => {
    expect(
      (await t.kernel.execute("slack.bot_replace_tokens", tokens(), ownerCaller())).status,
    ).toBe("error");
    await connect();
    await t.tdb.db.update(slackBot).set({
      syncState: "revoked",
      failures: 4,
      failingSince: t.clock.now(),
      lastError: "Jarvis's Slack tokens were revoked.",
      syncedAt: t.clock.now(),
    });
    s.bot.token = "xoxb-3333-4444-newbot";
    install("install-new-pc");
    t.clock.advance(60_000);
    await ok("slack.bot_replace_tokens", tokens());
    const row = await bot();
    expect(row).toMatchObject({
      installId: "install-new-pc",
      syncState: "ok",
      failures: 0,
      failingSince: null,
      lastError: null,
      syncedAt: null,
      connectedAt: t.clock.now(),
    });
    expect(openBotToken(services, row, "bot")).toBe("xoxb-3333-4444-newbot");
  });

  it("starts members' replies on their own once, and a switch you turn off stays off", async () => {
    await connect();
    // The team's wildcard holds the rule for every member of it.
    const [wild] = await t.tdb.db
      .select()
      .from(principal)
      .where(eq(principal.id, memberPrincipal("T1", "*")));
    expect(wild).toMatchObject({ kind: "member", displayName: "Everyone in Acme" });
    expect(await autoRule()).toHaveLength(1);
    expect(await t.kernel.hasStandingRule("slack.reply", memberCaller("T1", "U_SAM"))).toBe(true);

    expect(await ok("slack.bot_settings", { answersOnOwn: false, membersOn: true })).toEqual({
      answersOnOwn: false,
      membersOn: true,
      // Your own DM to Jarvis gets fixed replies in Slack until you choose full answers (D62).
      ownerDmAnswers: "fixed",
    });
    expect(await t.kernel.hasStandingRule("slack.reply", memberCaller("T1", "U_SAM"))).toBe(false);
    // Disconnecting and connecting again doesn't turn it back on behind your back.
    await ok("slack.bot_disconnect");
    await connect();
    expect(await autoRule()).toEqual([]);
    expect(await ok("slack.bot_settings", { answersOnOwn: true, ownerDmAnswers: "full" })).toEqual({
      answersOnOwn: true,
      membersOn: true,
      ownerDmAnswers: "full",
    });
    expect(await autoRule()).toHaveLength(1);
  });

  it("forgets the bot on disconnect, and what it hadn't sent doesn't go out later", async () => {
    await connect();
    const row = (id: string, state: "queued" | "sent") => ({
      id,
      dedupeKey: `send:${id}`,
      teamId: "T1",
      channelId: "DUSAM",
      text: "Build is fixed",
      kind: "send" as const,
      createdBy: PRINCIPAL.owner,
      state,
      expiresAt: new Date(t.clock.now().getTime() + 86_400_000),
    });
    const [waiting, sent] = [newId(), newId()];
    await t.tdb.db.insert(slackOutbox).values([row(waiting, "queued"), row(sent, "sent")]);
    expect(await ok("slack.bot_disconnect")).toEqual({ disconnected: true });
    expect(await t.tdb.db.select().from(slackBot)).toEqual([]);
    const states = await t.tdb.db.select().from(slackOutbox);
    expect(Object.fromEntries(states.map((o) => [o.id, o.state]))).toEqual({
      [waiting]: "failed",
      [sent]: "sent",
    });
    expect(await ok("slack.bot_status")).toMatchObject({ connected: false });
  });
});
