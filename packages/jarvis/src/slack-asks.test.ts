// Slack during the day, end to end: a message for you becomes a task at the next heartbeat when it
// asks you for something, linked to the message; one that already has a task is left alone, and a
// busy day stops at the cap. Hearth never posts.
import { randomBytes } from "node:crypto";
import { approval, heartbeatItem, jarvisTurn, link, notification } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import {
  FakeSlack,
  SLACK_ASKS,
  SLACK_FOR_YOU,
  SLACK_SERVICE,
  type TaskView,
  VAULT_SERVICE,
  Vault,
} from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
let s: FakeSlack;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("slack.sync", {}, integrationCaller("slack"));
const items = () => h.tdb.db.select().from(heartbeatItem);
const ref = (id: string) => `<m-ref type="slack_message" id="${id}">Slack message</m-ref>`;
const heartbeats = () => h.brain.requests.filter((r) => r.prompt.startsWith("Heartbeat."));

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
  s = new FakeSlack();
  s.clock = Math.floor(h.clock.now().getTime() / 1000) - 3600;
  s.conversations = [
    { id: "C1", name: "general", kind: "channel" },
    { id: "D1", name: "", kind: "dm", user: "UEVE" },
  ];
  s.users.set("UEVE", { id: "UEVE", name: "Eve", bot: false });
  h.kernel.services[SLACK_SERVICE] = s.api();
  h.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  await ok("slack.connect", { token: s.token });
  // The first sync brings in what was already there, quietly.
  s.post("D1", "UEVE", "Welcome aboard!");
  await sync();
  await h.settle();
});
afterEach(() => h.destroy());

describe("Slack messages for you", () => {
  it("makes a task of an ask at the next heartbeat, linked to the message", async () => {
    s.post("D1", "UEVE", "Can you send me the Q3 deck by Friday?");
    await sync();
    await h.settle();
    const [item] = await items();
    expect(item).toMatchObject({
      text: `${SLACK_FOR_YOU}: Eve in a direct message`,
      origin: "untrusted",
      takenAt: null,
    });
    expect(h.brain.requests).toHaveLength(0);

    const id = item!.aboutId!;
    h.brain.otherwise((req) =>
      req.prompt.startsWith("Heartbeat.")
        ? [
            { call: "record_read", input: { id } },
            {
              call: "task_create",
              input: {
                title: "Send Eve the Q3 deck",
                body: ref(id),
                dueAt: "2026-10-02T17:00:00-04:00",
              },
            },
            { say: "Made a task: Send Eve the Q3 deck." },
          ]
        : [{ say: "OK." }],
    );
    h.clock.set("2026-10-01T14:25:30Z"); // 10:25: the heartbeat
    await h.settle();

    const [beat] = heartbeats();
    expect(beat?.prompt).toContain("Never post or reply on Slack");
    expect(beat?.prompt).not.toContain("mail_draft");
    const [turn] = (await h.tdb.db.select().from(jarvisTurn)).filter(
      (t) => t.context.routine === "heartbeat",
    );
    expect(turn).toMatchObject({ mode: "proactive", origin: "untrusted", status: "done" });
    const [task] = await ok<TaskView[]>("task.list", {});
    expect(task).toMatchObject({ title: "Send Eve the Q3 deck" });
    expect(await h.tdb.db.select().from(link).where(eq(link.toId, id))).toMatchObject([
      { fromId: task!.id, kind: "mention" },
    ]);
    expect(await h.tdb.db.select().from(approval)).toEqual([]);
  });

  it("spends no turn on a message you've already made a task of", async () => {
    s.post("C1", "UEVE", "<@UME> can you review the budget?");
    await sync();
    await h.settle();
    const [item] = await items();
    expect(item?.text).toBe(`${SLACK_FOR_YOU}: Eve in #general`);
    await ok("task.create", { title: "Review the budget", body: ref(item!.aboutId!) });
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    expect(heartbeats()).toEqual([]);
  });

  it("sets aside one item per conversation, and shows the heartbeat how it went", async () => {
    for (const text of ["hey", "got a sec?", "can you review the Q3 deck?"])
      s.post("D1", "UEVE", text);
    s.post("D1", "UME", "sure, after lunch");
    s.post("D1", "UEVE", "thanks!");
    await sync();
    await h.settle();
    expect(await items()).toHaveLength(1);
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    const [beat] = heartbeats();
    expect(beat?.prompt).toContain(
      'Eve: "can you review the Q3 deck?"; the owner: "sure, after lunch"',
    );
  });

  it("looks again when someone pings after the task, saying a task exists", async () => {
    s.post("D1", "UEVE", "can you review the budget?");
    await sync();
    await h.settle();
    const [item] = await items();
    await ok("task.create", { title: "Review the budget", body: ref(item!.aboutId!) });
    h.clock.set("2026-10-01T14:10:00Z");
    s.post("D1", "UEVE", "any update?");
    await sync();
    await h.settle();
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    const [beat] = heartbeats();
    expect(beat?.prompt).toContain('Eve: "any update?"');
    expect(beat?.prompt).toContain(
      'A task was made from this conversation before: "Review the budget"',
    );
  });

  it(`sets aside at most ${SLACK_ASKS} conversations a day, and says so once`, async () => {
    for (let n = 0; n <= SLACK_ASKS + 1; n++) s.post("C1", "UEVE", `<@UME> question ${n}?`);
    await sync();
    await h.settle();
    expect(await items()).toHaveLength(SLACK_ASKS);
    const busy = await h.tdb.db
      .select()
      .from(notification)
      .where(eq(notification.kind, "slack.busy"));
    expect(busy).toHaveLength(1);
  });
});
