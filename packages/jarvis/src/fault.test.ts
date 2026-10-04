// Fault injection (D54): Claude failing in each of the ways it does, and Jarvis telling the
// owner, retrying only what's safe, publishing the plain brief, and reporting its health.
import { entity, jarvisTurn, notification, schedule, setting } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { FaultyBrain, hung, killed, rejectTool, serverError, usageLimit } from "./brains/faulty.ts";
import { ScriptedBrain } from "./brains/scripted.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
let script: ScriptedBrain;
let brain: FaultyBrain;
afterEach(() => h.destroy());

async function start(at = "2026-10-01T14:00:00Z", limits = {}) {
  script = new ScriptedBrain();
  brain = new FaultyBrain(script);
  h = await createJarvisHarness(at, { brain, runner: { limits, stopCheckMs: 20 } });
}

async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await h.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const turns = () => h.tdb.db.select().from(jarvisTurn);
const alerts = () =>
  h.tdb.db.select().from(notification).where(eq(notification.kind, "system.alert"));
async function health() {
  const [row] = await h.tdb.db.select().from(setting).where(eq(setting.key, "health.jarvis"));
  return row?.value as { status: string; detail: string } | undefined;
}
async function log(conversationId: string) {
  const c = await ok<{ log: { kind: string; payload: Record<string, unknown> }[] }>(
    "conversation.get",
    { id: conversationId },
  );
  return c.log;
}
const said = async (cid: string) =>
  (await log(cid))
    .filter((l) => l.kind === "error" || l.kind === "notice" || l.kind === "assistant_message")
    .map((l) => String(l.payload.message ?? l.payload.text));
const briefs = () => h.tdb.db.select().from(entity).where(eq(entity.type, "brief"));
async function lastOutcome(id: string) {
  const [row] = await h.tdb.db.select().from(schedule).where(eq(schedule.id, id));
  return row?.lastOutcome;
}
const chat = (text: string) => ok<{ conversationId: string }>("chat.send", { text });
const BRIEF_TIME = "2026-10-02T12:15:10Z"; // Friday 8:15 a.m.

describe("a tool Claude rejects", () => {
  it("is left out and the turn tried again, with an alert naming it", async () => {
    await start();
    brain.fail(rejectTool("sheet_save"));
    script.next([{ say: "Hello." }]);
    const { conversationId } = await chat("hi");
    await h.settle();

    expect(brain.requests).toHaveLength(2);
    const names = (i: number) => brain.requests[i]!.tools.map((t) => t.name);
    expect(names(0)).toContain("sheet_save");
    expect(names(1)).not.toContain("sheet_save");
    expect(names(1).length).toBe(names(0).length - 1);
    expect((await turns())[0]).toMatchObject({ status: "done", reply: "Hello." });
    expect(await said(conversationId)).toEqual(["Hello."]);

    const [alert] = await alerts();
    expect(alert).toMatchObject({
      title: "Jarvis is working without one of its tools",
      urgency: "interrupt",
    });
    expect(alert?.body).toContain("sheet_save");
    expect(alert?.deliveredAt).not.toBeNull();
    expect(await health()).toMatchObject({ status: "degraded" });
    expect((await health())?.detail).toContain("sheet_save");

    // Later turns leave it out from the start, without asking Claude twice.
    await chat("again");
    await h.settle();
    expect(brain.requests).toHaveLength(3);
    expect(brain.requests[2]!.tools.map((t) => t.name)).not.toContain("sheet_save");
    expect(await alerts()).toHaveLength(1);
  });
});

describe("Claude failing", () => {
  it("retries a 500 at 1, 5 and 15 minutes, then publishes the plain brief and alerts", async () => {
    await start();
    brain.fail(serverError, serverError, serverError, serverError);
    h.clock.set(BRIEF_TIME);
    await h.settle();

    let [turn] = await turns();
    expect(turn).toMatchObject({ status: "queued", attempts: 1, errorKind: "overloaded" });
    expect(turn?.notBefore).toEqual(new Date("2026-10-02T12:16:10Z"));
    expect(await health()).toMatchObject({ status: "degraded" });
    expect(await lastOutcome("routine:assistant.brief")).toBe("retrying");
    expect(await alerts()).toHaveLength(0);
    expect(await briefs()).toHaveLength(0);

    for (const minutes of [1, 5, 15]) {
      h.clock.advance(minutes * 60_000);
      await h.settle();
    }
    expect(brain.requests).toHaveLength(4);
    [turn] = await turns();
    expect(turn).toMatchObject({ status: "failed", attempts: 4, errorKind: "overloaded" });
    expect(turn?.toolsUsed).toEqual([]);

    const [brief] = await briefs();
    expect(brief?.body).toContain("Brief for 2026-10-02");
    const [alert] = await alerts();
    expect(alert).toMatchObject({
      title: "Jarvis couldn't finish your morning brief",
      urgency: "interrupt",
    });
    expect(alert?.body).toContain("Hearth published the plain version instead.");
    expect(alert?.deliveredAt).not.toBeNull();
    expect(await health()).toMatchObject({ status: "failing" });
    expect(await lastOutcome("routine:assistant.brief")).toBe("failed");

    // The owner reads plain words, never the API's.
    const lines = await said(turn!.conversationId!);
    expect(lines.at(-1)).toBe("Claude is overloaded right now, even after a few tries.");
    expect(lines.join("\n")).not.toMatch(/API Error|500|api_error/);
  });

  it("waits for a usage limit to reset, then answers", async () => {
    await start();
    const resetsAt = new Date("2026-10-01T14:40:00Z");
    brain.fail(usageLimit(resetsAt));
    script.next([{ say: "Back." }]);
    const { conversationId } = await chat("hi");
    await h.settle();

    const [turn] = await turns();
    expect(turn).toMatchObject({ status: "queued", errorKind: "rate_limit" });
    expect(turn?.notBefore).toEqual(new Date("2026-10-01T14:40:30Z"));
    expect(await said(conversationId)).toEqual([
      "You've hit your Claude usage limit. Jarvis will try again at 10:40 a.m.",
    ]);
    expect(await health()).toMatchObject({ status: "degraded" });

    h.clock.set("2026-10-01T14:40:31Z");
    await h.settle();
    expect((await turns())[0]).toMatchObject({ status: "done", reply: "Back." });
    expect(await health()).toEqual(expect.objectContaining({ status: "ok", detail: "Running" }));
    expect(await alerts()).toHaveLength(0);
  });

  it("publishes the plain brief at once when the limit lifts too late to wait", async () => {
    await start();
    brain.fail(usageLimit(new Date("2026-10-02T17:00:00Z")));
    h.clock.set(BRIEF_TIME);
    await h.settle();
    expect(brain.requests).toHaveLength(1);
    expect((await turns())[0]).toMatchObject({ status: "failed", errorKind: "rate_limit" });
    expect(await briefs()).toHaveLength(1);
    expect((await alerts())[0]?.title).toBe("Jarvis couldn't finish your morning brief");
    expect(await health()).toMatchObject({ status: "failing" });
  });

  it("tries again after the model process is killed", async () => {
    await start();
    brain.fail(killed);
    script.next([{ say: "Done." }]);
    await chat("hi");
    await h.settle();
    expect((await turns())[0]).toMatchObject({ status: "queued", errorKind: "crashed" });
    h.clock.advance(61_000);
    await h.settle();
    expect((await turns())[0]).toMatchObject({ status: "done", attempts: 2, errorKind: null });
    expect(await health()).toMatchObject({ status: "ok" });
  });

  it("stops a hung brain at the lane's time limit and publishes the plain brief", async () => {
    await start("2026-10-01T14:00:00Z", { deep: 150 });
    brain.fail(hung);
    h.clock.set(BRIEF_TIME);
    await h.settle();
    const [turn] = await turns();
    expect(turn).toMatchObject({ status: "failed", errorKind: "timeout" });
    expect(await briefs()).toHaveLength(1);
    expect((await alerts())[0]?.title).toBe("Jarvis couldn't finish your morning brief");
    expect(await health()).toMatchObject({ status: "failing" });
    expect((await said(turn!.conversationId!)).at(-1)).toMatch(/limit, so it stopped/);
  });

  it("never retries a turn once a tool has run", async () => {
    await start();
    // A tool runs, then the API fails: running it twice could do the thing twice.
    let calls = 0;
    script.run = async (req) => {
      calls++;
      await req.tools.find((t) => t.name === "task_create")!.run({ title: "Book dentist" });
      throw new Error("API Error: 529 overloaded");
    };
    await chat("remind me to book the dentist");
    await h.settle();
    const [turn] = await turns();
    expect(turn).toMatchObject({ status: "failed", errorKind: "overloaded" });
    expect(turn?.toolsUsed).toEqual(["task.create"]);
    expect(calls).toBe(1);
  });
});
