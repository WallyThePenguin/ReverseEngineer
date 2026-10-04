import { randomBytes } from "node:crypto";
import { audit, event, link, slackWorkspace } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { SLACK_SERVICE } from "./api.ts";
import { FakeSlack } from "./fake.ts";
import { slackModule } from "./index.ts";
import { plainText } from "./sync.ts";

let t: TestKernel;
let s: FakeSlack;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  s = new FakeSlack();
  s.clock = Math.floor(t.clock.now().getTime() / 1000) - 3600;
  s.conversations = [
    { id: "C1", name: "general", kind: "channel" },
    { id: "D1", name: "", kind: "dm", user: "UANA" },
  ];
  s.users.set("UANA", { id: "UANA", name: "Ana", email: "Ana@Friends.example", bot: false });
  s.users.set("UBOB", { id: "UBOB", name: "Bob", bot: false });
  s.users.set("UME", { id: "UME", name: "Me", bot: false });
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () =>
  ok<{ added: number; mentions: number; error?: string }>(
    "slack.sync",
    {},
    integrationCaller("slack"),
  );
const inbox = () =>
  ok<{ notification: { kind: string; title: string; entityId: string } }[]>("inbox.list");
const connect = () => ok<{ team: string }>("slack.connect", { token: s.token });

describe("slack", () => {
  it("connects with a sealed token the audit log never sees", async () => {
    expect(await connect()).toMatchObject({ team: "Acme" });
    const [ws] = await t.tdb.db.select().from(slackWorkspace);
    expect(ws?.token).toMatch(/^v1\./);
    expect(ws?.token).not.toContain(s.token);
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "slack.connect"));
    expect(JSON.stringify(rows)).not.toContain(s.token);
    const status = await ok<{ connected: boolean }>("slack.status");
    expect(status).toMatchObject({ connected: true, team: "Acme" });
    expect(JSON.stringify(status)).not.toContain(s.token);
  });

  it("refuses a bad token, and Jarvis can't connect one", async () => {
    const bad = await t.kernel.execute(
      "slack.connect",
      { token: "xoxp-1234567890-nope" },
      ownerCaller(),
    );
    expect(bad).toMatchObject({ status: "error", code: "invalid_input" });
    const jarvis = await t.kernel.execute(
      "slack.connect",
      { token: s.token },
      jarvisCaller("owner"),
    );
    expect(jarvis.status).toBe("denied");
  });

  it("reads channels in quietly first, then puts mentions and direct messages in the inbox", async () => {
    await ok("person.create", { name: "Ana Silva" }).then((p) =>
      ok("person.add_email", { id: (p as { id: string }).id, email: "ana@friends.example" }),
    );
    s.post("C1", "UBOB", "Old news &amp; <https://x.example|a link>");
    s.post("C1", "UANA", "Earlier ping <@UME>");
    await connect();
    expect(await sync()).toMatchObject({ added: 1, mentions: 1 });
    expect(await inbox()).toEqual([]);

    s.post("C1", "UBOB", "Lunch is here");
    const ping = s.post("C1", "UANA", "<@UME> can you look at the deploy?");
    s.post("C1", "UANA", "Thread reply for <@UME>", ping);
    s.post("D1", "UANA", "Quick question");
    s.post("C1", "UME", "I said <@UME>");
    const r = await sync();
    expect(r.error).toBeUndefined();
    const items = (await inbox()).map((i) => i.notification.title).sort();
    expect(items).toEqual([
      "Ana mentioned you in #general",
      "Ana mentioned you in #general",
      "Ana sent you a direct message on Slack",
    ]);
    // Nothing twice.
    await sync();
    expect(await inbox()).toHaveLength(3);

    const msgs = await ok<{ id: string; text: string; type: string }[]>("slack.messages", {
      channel: "#general",
      query: "news",
    });
    expect(msgs).toMatchObject([
      { type: "slack_message", text: "Old news & a link (https://x.example)" },
    ]);
    const mine = await ok<{ mentionsMe: boolean; title: string }[]>("slack.messages", {
      mentionsMe: true,
    });
    expect(mine.every((m) => !m.title.startsWith("Me "))).toBe(true);

    // Ana's messages are linked to the person she is, by her Slack email.
    const deploy = await ok<{ id: string }[]>("slack.messages", { query: "deploy" });
    const links = await t.tdb.db.select().from(link).where(eq(link.fromId, deploy[0]!.id));
    expect(links).toMatchObject([{ kind: "participant" }]);
    // Jarvis reads it as outside content.
    expect(t.kernel.registry.isOutsideType("slack_message")).toBe(true);
    const digest = await slackModule.digest!({
      db: t.tdb.db,
      now: t.clock.now(),
      since: new Date(0),
    });
    expect(digest.every((d) => d.outside)).toBe(true);
  });

  it("reads a few channels a round, least recently read first", async () => {
    s.conversations = Array.from({ length: 20 }, (_, i) => ({
      id: `C${i + 10}`,
      name: `c${i}`,
      kind: "channel" as const,
    }));
    await connect();
    await sync();
    expect(s.calls.length).toBe(15);
    s.calls = [];
    await sync();
    expect(s.calls.slice(0, 5).map((c) => c.split(" ")[1])).toEqual([
      "C25",
      "C26",
      "C27",
      "C28",
      "C29",
    ]);
  });

  it("stops reading a channel you turn off, and says when the token stops working", async () => {
    await connect();
    await sync();
    await ok("slack.set_channel", { id: "C1", ingest: false });
    s.calls = [];
    await sync();
    expect(s.calls).toEqual(["history D1"]);
    s.token = "xoxp-rotated-token";
    expect((await sync()).error).toMatch(/Slack/);
    const failed = await t.tdb.db.select().from(event).where(eq(event.kind, "slack.sync_failed"));
    expect(failed).toHaveLength(1);
  });

  it("forgets everything on disconnect", async () => {
    s.post("C1", "UBOB", "hello");
    await connect();
    await sync();
    await ok("slack.disconnect");
    expect(await ok("slack.messages")).toEqual([]);
    expect(await ok("slack.status")).toMatchObject({ connected: false });
    // Only the integration reads Slack in, so nothing from it looks like the owner's own.
    expect(await t.kernel.execute("slack.sync", {}, ownerCaller())).toMatchObject({
      status: "denied",
    });
    expect(await t.kernel.execute("slack.channels", {}, jarvisCaller("agent"))).toMatchObject({
      status: "denied",
    });
  });

  it("turns Slack markup into plain text", () => {
    const names = new Map([["U1", "Ana"]]);
    expect(plainText("<@U1> see <#C9|ops> <!here> <https://a.example> &lt;b&gt;", names)).toBe(
      "@Ana see #ops @here https://a.example <b>",
    );
  });
});
