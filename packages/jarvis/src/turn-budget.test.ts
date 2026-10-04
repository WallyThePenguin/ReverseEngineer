// The turn budget for browsing (B1, 1.16): a turn that uses the browser gets more steps and more
// time, and a turn that runs out of steps stops with what it said and offers to carry on.
import { conversation, jarvisTurn } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { BROWSER_SERVICE } from "@hearth/modules";
import { FakeBrowser } from "@hearth/modules/testing";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { BrainRequest } from "./brain.ts";
import type { ScriptStep } from "./brains/scripted.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";
import { BROWSER_STEPS, CARRY_ON, OUT_OF_STEPS } from "./turn-budget.ts";

let h: JarvisHarness;
afterEach(() => h.destroy());

async function start(limits = {}) {
  h = await createJarvisHarness("2026-10-01T14:00:00Z", { runner: { limits } });
  h.kernel.services[BROWSER_SERVICE] = new FakeBrowser({});
}
async function chat(text: string) {
  const res = await h.kernel.execute<{ conversationId: string }>(
    "chat.send",
    { text },
    ownerCaller(),
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result.conversationId;
}
const turns = () => h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));
async function said(cid: string): Promise<string[]> {
  const res = await h.kernel.execute<{ log: { kind: string; payload: { text?: string } }[] }>(
    "conversation.get",
    { id: cid },
    ownerCaller(),
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result.log
    .filter((l) => l.kind === "assistant_message")
    .map((l) => l.payload.text ?? "");
}
const browse: ScriptStep = { call: "browser_tabs", input: {} };

describe("a turn that runs out of steps", () => {
  it("gets more when it's using the browser, in the same session, until it's done", async () => {
    await start();
    const asked: BrainRequest[] = [];
    h.brain.next([browse, { say: "Still looking." }, { outOfSteps: 40 }]);
    h.brain.next((req) => {
      asked.push(req);
      return [browse, { say: "Found it: the blue one." }];
    });
    const cid = await chat("find me a kettle");
    await h.settle();

    expect(h.brain.requests).toHaveLength(2);
    expect(asked[0]).toMatchObject({
      prompt: CARRY_ON,
      sessionId: "scripted-session",
      maxTurns: BROWSER_STEPS - 40,
    });
    const [turn] = await turns();
    expect(turn).toMatchObject({ status: "done", reply: "Found it: the blue one." });
    expect(await said(cid)).toEqual(["Still looking.", "Found it: the blue one."]);
  });

  it("stops at the browser's allowance in all, with what it said and an offer to carry on", async () => {
    await start();
    h.brain.next([browse, { say: "Page one of many." }, { outOfSteps: 40 }]);
    h.brain.next([browse, { say: "Page eighty." }, { outOfSteps: BROWSER_STEPS - 40 }]);
    const cid = await chat("read every page");
    await h.settle();

    expect(h.brain.requests).toHaveLength(2);
    const [turn] = await turns();
    expect(turn).toMatchObject({ status: "done", reply: `Page eighty.\n\n${OUT_OF_STEPS}` });
    expect((await said(cid)).at(-1)).toBe(OUT_OF_STEPS);
  });

  it("stops at once when it isn't browsing, and a 'continue' picks up its session", async () => {
    await start();
    h.brain.next([{ call: "task_create", input: { title: "Plan" } }, { outOfSteps: 40 }]);
    const cid = await chat("plan my week");
    await h.settle();

    expect(h.brain.requests).toHaveLength(1);
    const [turn] = await turns();
    expect(turn).toMatchObject({ status: "done", reply: OUT_OF_STEPS, outcome: "act" });
    const [conv] = await h.tdb.db.select().from(conversation).where(eq(conversation.entityId, cid));
    expect(conv?.agentSessionId).toBe("scripted-session");

    await h.kernel.execute("chat.send", { text: "continue", conversationId: cid }, ownerCaller());
    await h.settle();
    expect(h.brain.requests[1]).toMatchObject({
      prompt: "continue",
      sessionId: "scripted-session",
    });
  });
});

describe("a turn's time", () => {
  it("is the browser's once the turn uses the browser", async () => {
    await start({ fast: 400, browser: 20_000 });
    h.brain.next([browse, { wait: 900 }, { say: "Done browsing." }]);
    await chat("look something up");
    await h.settle();
    expect((await turns())[0]).toMatchObject({ status: "done", reply: "Done browsing." });
  });

  it("is still its lane's when it doesn't", async () => {
    await start({ fast: 400, browser: 20_000 });
    // Says nothing after its wait: the turn is long over by then.
    h.brain.next([{ wait: 900 }]);
    await chat("think hard");
    await h.settle();
    expect((await turns())[0]).toMatchObject({ status: "failed", errorKind: "timeout" });
  });
});
