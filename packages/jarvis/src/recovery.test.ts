// Stop, Retry, restarts, lost sessions, stale requests and runs of failures (D54).
import {
  conversation,
  heartbeatItem,
  jarvisTurn,
  notification,
  schedule,
  setting,
} from "@hearth/db";
import { newId, ownerCaller } from "@hearth/kernel";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Fault, FaultyBrain, hung, sessionGone } from "./brains/faulty.ts";
import { ScriptedBrain } from "./brains/scripted.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";
import { writeLog } from "./threads.ts";

let h: JarvisHarness;
let script: ScriptedBrain;
let brain: FaultyBrain;
afterEach(() => h.destroy());

async function start(at = "2026-10-01T14:00:00Z") {
  script = new ScriptedBrain();
  brain = new FaultyBrain(script);
  h = await createJarvisHarness(at, { brain, runner: { stopCheckMs: 20 } });
}

async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await h.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const turns = () => h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));
const turn = async (id: string) =>
  (await h.tdb.db.select().from(jarvisTurn).where(eq(jarvisTurn.id, id)))[0];
const alerts = () =>
  h.tdb.db.select().from(notification).where(eq(notification.kind, "system.alert"));
async function health() {
  const [row] = await h.tdb.db.select().from(setting).where(eq(setting.key, "health.jarvis"));
  return row?.value as { status: string; detail: string } | undefined;
}
async function said(conversationId: string) {
  const c = await ok<{ log: { kind: string; payload: Record<string, unknown> }[] }>(
    "conversation.get",
    { id: conversationId },
  );
  return c.log
    .filter((l) => l.kind === "error" || l.kind === "notice" || l.kind === "assistant_message")
    .map((l) => String(l.payload.message ?? l.payload.text));
}
const chat = (text: string, conversationId?: string) =>
  ok<{ conversationId: string }>("chat.send", {
    text,
    ...(conversationId ? { conversationId } : {}),
  });
const invalid: Fault = () =>
  new Error(
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0: bad"}}',
  );

describe("Stop", () => {
  it("stops a running turn, even a brain that ignores the signal", async () => {
    await start();
    brain.fail(hung);
    const { conversationId } = await chat("write me an essay");
    await h.engine.processAvailable();
    const draining = h.runner.drain();
    await vi.waitFor(() => expect(brain.requests).toHaveLength(1));
    expect(await ok("jarvis.cancel_turn", { conversationId })).toEqual({
      canceled: 0,
      stopping: 1,
    });
    await draining;
    expect((await turns())[0]).toMatchObject({ status: "canceled", errorKind: "canceled" });
    expect(await said(conversationId)).toEqual(["Stopped."]);
    expect(await alerts()).toHaveLength(0);
    expect(await health()).toMatchObject({ status: "ok" });
  });

  it("stops a turn through the runner, as the Jarvis process does when told", async () => {
    await start();
    brain.fail(hung);
    await chat("hi");
    await h.engine.processAvailable();
    const draining = h.runner.drain();
    await vi.waitFor(() => expect(brain.requests).toHaveLength(1));
    const [t] = await turns();
    expect(h.runner.cancel(t!.id)).toBe(true);
    await draining;
    expect(await turn(t!.id)).toMatchObject({ status: "canceled" });
    expect(h.runner.cancel(t!.id)).toBe(false);
  });

  it("cancels a turn still waiting, and Retry runs it once", async () => {
    await start();
    const { conversationId } = await chat("hi");
    await h.engine.processAvailable();
    expect(await ok("jarvis.cancel_turn", { conversationId })).toEqual({
      canceled: 1,
      stopping: 0,
    });
    await h.settle();
    expect(brain.requests).toHaveLength(0);
    const [t] = await turns();
    expect(t).toMatchObject({ status: "canceled" });
    expect(await said(conversationId)).toEqual(["Stopped before Jarvis started."]);

    const { turnId } = await ok<{ turnId: string }>("jarvis.retry_turn", { turnId: t!.id });
    expect(await ok("jarvis.retry_turn", { turnId: t!.id })).toEqual({ turnId });
    script.next([{ say: "Hi." }]);
    await h.settle();
    expect(await turn(turnId)).toMatchObject({ status: "done", reply: "Hi.", mode: "reactive" });
    const again = await h.kernel.execute("jarvis.retry_turn", { turnId }, ownerCaller());
    expect(again).toMatchObject({ status: "error", code: "conflict" });
  });
});

describe("after a restart", () => {
  it("runs again a turn that hadn't used a tool, and ends one that had", async () => {
    await start();
    const a = await chat("first");
    const b = await chat("second");
    await h.engine.processAvailable();
    const [ta, tb] = await turns();
    await writeLog(h.kernel, b.conversationId, [
      {
        kind: "tool_call",
        payload: { name: "task_create", input: {}, callId: "c1" },
        turnId: tb!.id,
      },
    ]);
    await h.tdb.db
      .update(jarvisTurn)
      .set({ status: "running", startedAt: h.clock.now(), attempts: 1 });

    expect(await h.runner.recoverInterrupted()).toBe(2);
    expect(await turn(ta!.id)).toMatchObject({ status: "queued", errorKind: "interrupted" });
    expect(await turn(tb!.id)).toMatchObject({ status: "failed", errorKind: "interrupted" });
    expect(await said(a.conversationId)).toEqual([
      "Jarvis restarted, so it's starting this again.",
    ]);
    expect(await said(b.conversationId)).toEqual([
      "Jarvis restarted while working on this, so it didn't finish.",
    ]);
    expect(await alerts()).toHaveLength(0);

    script.next([{ say: "Here." }]);
    await h.settle();
    expect(await turn(ta!.id)).toMatchObject({ status: "done", attempts: 2 });
    // A restart isn't Jarvis failing.
    expect(await health()).toMatchObject({ status: "ok" });
  });
});

describe("a lost session", () => {
  it("starts again from a recap Hearth writes", async () => {
    await start();
    script.next([{ say: "Paris." }]);
    const { conversationId } = await chat("What's the capital of France?");
    await h.settle();
    brain.fail(sessionGone);
    script.next([{ say: "About two million." }]);
    await chat("And how many people live there?", conversationId);
    await h.settle();

    expect(brain.requests).toHaveLength(3);
    expect(brain.requests[1]?.sessionId).toBe("scripted-session");
    const retry = brain.requests[2]!;
    expect(retry.sessionId).toBeNull();
    expect(retry.prompt).toContain("What's the capital of France?");
    expect(retry.prompt).toContain("Jarvis");
    expect(retry.prompt).toContain("Paris.");
    expect(retry.prompt.trim().endsWith("And how many people live there?")).toBe(true);
    expect(retry.prompt.match(/And how many people/g)).toHaveLength(1);
    expect((await turns())[1]).toMatchObject({ status: "done", reply: "About two million." });
    const [c] = await h.tdb.db
      .select()
      .from(conversation)
      .where(eq(conversation.entityId, conversationId));
    expect(c?.agentSessionId).toBe("scripted-session");
  });
});

describe("waiting too long", () => {
  it("lets a chat go after an hour unanswered, with a Retry", async () => {
    await start();
    const { conversationId } = await chat("hi");
    await h.engine.processAvailable();
    h.clock.advance(61 * 60_000);
    await h.settle();
    expect(brain.requests).toHaveLength(0);
    expect((await turns())[0]).toMatchObject({ status: "skipped", skipReason: "expired" });
    expect(await said(conversationId)).toEqual([
      "Jarvis didn't get to this in time, so it let it go.",
    ]);
  });

  it("counts from when you asked, not from when Jarvis came back", async () => {
    await start();
    const { conversationId } = await chat("hi");
    // Jarvis is down for an hour: nothing even queues the turn.
    h.clock.advance(61 * 60_000);
    await h.settle();
    expect(brain.requests).toHaveLength(0);
    expect((await turns())[0]).toMatchObject({ status: "skipped", skipReason: "expired" });
    // Retry asks again now.
    const [t] = await turns();
    const { turnId } = await ok<{ turnId: string }>("jarvis.retry_turn", { turnId: t!.id });
    await h.settle();
    expect(await turn(turnId)).toMatchObject({ status: "done" });
    expect(await said(conversationId)).toHaveLength(2);
  });

  it("lets go of a message Jarvis hasn't seen when you press Stop", async () => {
    await start();
    const { conversationId } = await chat("hi");
    expect(await ok("jarvis.cancel_turn", { conversationId })).toEqual({
      canceled: 0,
      stopping: 0,
    });
    await h.settle();
    expect(brain.requests).toHaveLength(0);
    expect(await turns()).toHaveLength(0);
    expect(await said(conversationId)).toEqual(["Stopped before Jarvis started."]);
    // What you send after that is answered as usual.
    await chat("are you back?", conversationId);
    await h.settle();
    expect(brain.requests).toHaveLength(1);
    // With nothing left waiting, Stop doesn't say it stopped anything.
    const before = await said(conversationId);
    await ok("jarvis.cancel_turn", { conversationId });
    expect(await said(conversationId)).toEqual(before);
  });
});

describe("routines", () => {
  it("records a second firing of the same brief as a skipped duplicate", async () => {
    await start();
    h.clock.set("2026-10-02T12:15:10Z");
    await h.settle();
    const [fired] = (await h.events("clock.fired")).filter(
      (e) => e.payload.scheduleId === "routine:assistant.brief",
    );
    await h.engine.handle(fired!);
    const rows = await turns();
    expect(rows.map((r) => r.status)).toEqual(["done", "skipped"]);
    expect(rows[1]).toMatchObject({ skipReason: "duplicate", dedupeKey: null });
    const [s] = await h.tdb.db
      .select()
      .from(schedule)
      .where(eq(schedule.id, "routine:assistant.brief"));
    expect(s?.lastOutcome).toBe("skipped_duplicate");
  });

  it("dates a late journal by the day it was due", async () => {
    await start();
    h.clock.set("2026-10-02T04:30:10Z"); // 12:30 a.m., five hours after 7:30 p.m.
    await h.settle();
    const journal = (await turns()).find((t) => t.context.routine === "journal");
    expect(journal).toMatchObject({ dedupeKey: "journal:2026-10-01", status: "done" });
    expect(journal?.context.date).toBe("2026-10-01");
  });

  it("reads a late memory update's day from when it was due, leaving no gap", async () => {
    await start("2026-10-01T07:00:00Z"); // 3 a.m., after the 1:45 a.m. update
    await chat("I adopted a cat named Miso");
    await h.settle();
    h.clock.set("2026-10-02T10:00:10Z"); // 6 a.m.: the 1:45 a.m. update is four hours late
    await h.settle();
    const memory = brain.requests.find((r) => r.prompt.startsWith("Nightly memory update"));
    expect(memory?.prompt).toContain("Nightly memory update for 2026-10-01");
    expect(memory?.prompt).toContain("Miso");
  });

  it("puts a failed heartbeat's items back for the next one", async () => {
    await start();
    await h.tdb.db.insert(heartbeatItem).values([{ id: newId(), text: "A PR was opened" }]);
    brain.fail(invalid);
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    expect((await turns())[0]).toMatchObject({ status: "failed", errorKind: "invalid_request" });
    const [item] = await h.tdb.db.select().from(heartbeatItem);
    expect(item?.takenAt).toBeNull();
    expect((await alerts())[0]?.title).toBe("Jarvis couldn't finish a heartbeat check");
  });
});

describe("a run of failures", () => {
  it("alerts once per run, again at three in a row, and anew after a recovery", async () => {
    await start();
    brain.fail(invalid, invalid, invalid);
    for (const text of ["one", "two", "three"]) {
      await chat(text);
      await h.settle();
    }
    expect(new Set((await alerts()).map((a) => a.title))).toEqual(
      new Set(["Jarvis's turns are failing", "Jarvis has failed 3 turns in a row"]),
    );
    expect(await alerts()).toHaveLength(2);
    expect(await health()).toMatchObject({ status: "failing" });
    expect((await health())?.detail).toContain("That's 3 in a row.");

    script.next([{ say: "Fine now." }]);
    await chat("four");
    await h.settle();
    expect(await health()).toMatchObject({ status: "ok" });

    brain.fail(invalid);
    await chat("five");
    await h.settle();
    const failing = (await alerts()).filter((a) => a.title === "Jarvis's turns are failing");
    expect(failing).toHaveLength(2);
  });

  it("keeps a long outage to one set of alerts, and counts all of it", async () => {
    await start();
    for (let i = 0; i < 30; i++) {
      brain.fail(invalid);
      await chat(`message ${i}`);
      await h.settle();
      h.clock.advance(60_000);
    }
    expect((await alerts()).map((a) => a.title).sort()).toEqual([
      "Jarvis has failed 3 turns in a row",
      "Jarvis's turns are failing",
    ]);
    expect((await health())?.detail).toContain("That's 30 in a row.");
  }, 60_000);
});
