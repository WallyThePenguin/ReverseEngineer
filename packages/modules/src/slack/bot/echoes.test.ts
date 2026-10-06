// No echoes (D62): your own token's poller leaves out your DM with Jarvis and everything Jarvis
// posts, so Jarvis's words never come back in as Slack messages, or as inbox items, for it to read.
import { randomBytes } from "node:crypto";
import { entity, slackChannel, slackMessage } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../../browser/vault.ts";
import { ALL_MODULES } from "../../index.ts";
import { INSTALL_SERVICE } from "../../install.ts";
import { SLACK_SERVICE } from "../api.ts";
import { FakeSlack } from "../fake.ts";
import { SLACK_BOT_SERVICE } from "./api.ts";

let t: TestKernel;
let s: FakeSlack;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  s = new FakeSlack();
  s.clock = Math.floor(t.clock.now().getTime() / 1000) - 3600;
  s.conversations = [
    { id: "C1", name: "general", kind: "channel" },
    { id: "D1", name: "", kind: "dm", user: "UANA" },
    // Your DM with Jarvis: your own token sees it like any other DM.
    { id: "DUME", name: "", kind: "dm", user: "UJARVIS" },
  ];
  s.users.set("UANA", { id: "UANA", name: "Ana", bot: false });
  s.users.set("UJARVIS", { id: "UJARVIS", name: "Jarvis", bot: true });
  s.users.set("UME", { id: "UME", name: "Me", bot: false });
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[SLACK_BOT_SERVICE] = s.botApi();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  t.kernel.services[INSTALL_SERVICE] = { id: () => "install-live" };
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok<{ error?: string }>("slack.sync", {}, integrationCaller("slack"));
const ingest = async (id: string) =>
  (await t.tdb.db.select().from(slackChannel).where(eq(slackChannel.id, id)))[0]?.ingest;
const saved = async () =>
  (
    await t.tdb.db
      .select({ body: entity.body })
      .from(slackMessage)
      .innerJoin(entity, eq(entity.id, slackMessage.entityId))
  )
    .map((r) => r.body)
    .sort();

describe("your own token's poller, once Jarvis's bot is connected", () => {
  it("doesn't read in your DM with Jarvis, or anything Jarvis posts, however it comes", async () => {
    await ok("slack.connect", { token: s.token });
    expect((await sync()).error).toBeUndefined();
    expect(await ingest("DUME")).toBe(true);
    await ok("slack.bot_connect", { botToken: s.bot.token, appToken: s.bot.appToken });
    expect(await ingest("DUME")).toBe(false);

    const jarvis = { botId: "BJARVIS" };
    const ask = s.post("C1", "UANA", "<@UJARVIS> when is Sam free?");
    // A reply in the thread, a post that @mentions you (search finds it), and your DM with it.
    s.post("C1", "UJARVIS", "Sam is free at 3.", ask, jarvis);
    s.post("C1", "UJARVIS", "Heads up <@UME>: the build is fixed.", undefined, jarvis);
    s.post("DUME", "UME", "Remind me to call Ana.");
    s.post("DUME", "UJARVIS", "Got it, it's in Hearth.", undefined, jarvis);
    s.post("D1", "UANA", "Lunch?");
    expect((await sync()).error).toBeUndefined();

    expect(await saved()).toEqual(["@Jarvis when is Sam free?", "Lunch?"]);
    const inbox = await ok<{ notification: { title: string } }[]>("inbox.list");
    expect(inbox.map((i) => i.notification.title)).toEqual([
      "Ana sent you a direct message on Slack",
    ]);

    // Ticking it back on is refused, and a later channel list keeps it off.
    const back = await t.kernel.execute(
      "slack.set_channel",
      { id: "DUME", ingest: true },
      ownerCaller(),
    );
    expect(back).toMatchObject({ status: "error", code: "invalid_input" });
    t.clock.advance(31 * 60_000);
    await sync();
    expect(await ingest("DUME")).toBe(false);
    expect(await saved()).toHaveLength(2);
  });
});
