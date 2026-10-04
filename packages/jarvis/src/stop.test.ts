// Stop means stop, and a retry never does a thing twice (D54): a Stop pressed while Jarvis was
// stuck survives the restart, a tool still running when the model fails rules out a retry, and
// a brain that carries on after Stop can't run anything.
import { jarvisTurn, task } from "@hearth/db";
import { type Caller, ownerCaller } from "@hearth/kernel";
import { asc } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaultyBrain } from "./brains/faulty.ts";
import { ScriptedBrain } from "./brains/scripted.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
let script: ScriptedBrain;
afterEach(() => h.destroy());

async function start() {
  script = new ScriptedBrain();
  h = await createJarvisHarness("2026-10-01T14:00:00Z", {
    brain: new FaultyBrain(script),
    runner: { stopCheckMs: 20 },
  });
}
async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await h.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const turns = () => h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));
const tasks = () => h.tdb.db.select().from(task);
const chat = (text: string) => ok<{ conversationId: string }>("chat.send", { text });

/** Makes one action slow, as a real send or sync can be. */
function slow(action: string, ms: number) {
  const real = h.kernel.execute.bind(h.kernel);
  vi.spyOn(h.kernel, "execute").mockImplementation(
    async (name: string, input: unknown, caller: Caller) => {
      if (name === action) await new Promise((r) => setTimeout(r, ms));
      return real(name, input, caller);
    },
  );
}

describe("Stop", () => {
  it("still holds after a restart when Jarvis was stuck at the time", async () => {
    await start();
    const { conversationId } = await chat("hi");
    await h.engine.processAvailable();
    // The Jarvis process took the turn, then hung (or died) before it could hear Stop.
    await h.tdb.db.update(jarvisTurn).set({ status: "running", attempts: 1 });
    expect(await ok("jarvis.cancel_turn", { conversationId })).toMatchObject({ stopping: 1 });

    await h.runner.recoverInterrupted();
    await h.settle();
    expect((await turns())[0]).toMatchObject({ status: "canceled", errorKind: "canceled" });
    expect(script.requests).toHaveLength(0);
  });

  it("isn't undone by a failure that lands before its signal does", async () => {
    await start();
    script.run = async () => {
      // You press Stop; the Jarvis process hasn't heard yet when Claude fails.
      await h.tdb.db.update(jarvisTurn).set({ cancelRequestedAt: h.clock.now() });
      throw new Error("API Error: 529 overloaded");
    };
    await chat("hi");
    await h.settle();
    expect((await turns())[0]).toMatchObject({ status: "canceled", errorKind: "canceled" });
  });

  it("leaves a brain that carries on unable to run anything", async () => {
    await start();
    let later: Promise<unknown> = Promise.resolve();
    script.run = (req) =>
      new Promise(() => {
        // Ignores the signal, and asks for a tool once the turn is over.
        req.signal.addEventListener("abort", () => {
          later = req.tools.find((t) => t.name === "task_create")!.run({ title: "Too late" });
        });
      });
    const { conversationId } = await chat("hi");
    await h.engine.processAvailable();
    const draining = h.runner.drain();
    await vi.waitFor(async () => expect((await turns())[0]?.status).toBe("running"));
    await ok("jarvis.cancel_turn", { conversationId });
    await draining;
    expect(await later).toMatch(/^Not run/);
    expect(await tasks()).toHaveLength(0);
  });
});

describe("a retry", () => {
  it("never follows a model failure while a tool was still running", async () => {
    await start();
    slow("task.create", 300);
    let pending: Promise<unknown> = Promise.resolve();
    let calls = 0;
    script.run = async (req) => {
      calls++;
      pending = req.tools.find((t) => t.name === "task_create")!.run({ title: "Book dentist" });
      throw new Error("API Error: 529 overloaded");
    };
    await chat("remind me to book the dentist");
    await h.settle();
    await pending;
    const [turn] = await turns();
    expect(turn).toMatchObject({ status: "failed", errorKind: "overloaded", attempts: 1 });
    h.clock.advance(61_000);
    await h.settle();
    expect(calls).toBe(1);
    expect(await tasks()).toHaveLength(1);
  });
});
