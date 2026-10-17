// Stop means stop, and a retry never does a thing twice (D54): a Stop pressed while Jarvis was
// stuck survives the restart, a tool still running when the model fails rules out a retry, a
// brain that carries on after Stop can't run anything, and one stopped first (or between tries)
// never starts. Jarvis's own stop (an update, D63) ends turns the same way, without calling them
// stopped.
import { conversationLog, jarvisTurn, task } from "@hearth/db";
import { type Caller, ownerCaller } from "@hearth/kernel";
import { asc, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainRequest } from "./brain.ts";
import { FaultyBrain, rejectTool } from "./brains/faulty.ts";
import { ScriptedBrain } from "./brains/scripted.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
let script: ScriptedBrain;
let brain: FaultyBrain;
afterEach(() => h.destroy());

async function start() {
  script = new ScriptedBrain();
  brain = new FaultyBrain(script);
  h = await createJarvisHarness("2026-10-01T14:00:00Z", { brain, runner: { stopCheckMs: 20 } });
}
async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await h.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const turns = () => h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));
const tasks = () => h.tdb.db.select().from(task);
const chat = (text: string) => ok<{ conversationId: string }>("chat.send", { text });

/** Does `first` each time an action runs, just before it runs. */
function before(action: string, first: () => unknown) {
  const real = h.kernel.execute.bind(h.kernel);
  vi.spyOn(h.kernel, "execute").mockImplementation(
    async (name: string, input: unknown, caller: Caller) => {
      if (name === action) await first();
      return real(name, input, caller);
    },
  );
}
/** Makes one action slow, as a real send or sync can be. */
const slow = (action: string, ms: number) =>
  before(action, () => new Promise((r) => setTimeout(r, ms)));

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
    let thinking = () => {};
    const started = new Promise<void>((r) => {
      thinking = r;
    });
    script.run = (req) =>
      new Promise(() => {
        // Ignores the signal, and asks for a tool once the turn is over.
        req.signal.addEventListener("abort", () => {
          later = req.tools.find((t) => t.name === "task_create")!.run({ title: "Too late" });
        });
        thinking();
      });
    const { conversationId } = await chat("hi");
    await h.engine.processAvailable();
    const draining = h.runner.drain();
    // Stop once the brain is running: pressed while the turn is still being set up, the brain
    // never starts (below), and there'd be nothing carrying on to test. A turn that ends before
    // the brain starts (a setup error, say) fails here at once, not at the test's timeout.
    if ((await Promise.race([started, draining.then(() => "ended")])) === "ended") {
      const [t] = await turns();
      throw new Error(`The turn ended before the brain started (${t?.status}: ${t?.error})`);
    }
    await ok("jarvis.cancel_turn", { conversationId });
    await draining;
    expect(await later).toMatch(/^Not run/);
    expect(await tasks()).toHaveLength(0);
  });

  it("doesn't start the brain once the turn is stopped", async () => {
    await start();
    await chat("hi");
    await h.engine.processAvailable();
    const turn = await h.runner.claimNext();
    // Stop reaches Jarvis while the turn is still being set up (its conversation read, memory
    // recalled, the prompt built): a model call started after that would only be thrown away.
    const running = h.runner.run(turn!);
    expect(h.runner.cancel(turn!.id)).toBe(true);
    await running;
    expect(script.requests).toHaveLength(0);
    expect((await turns())[0]).toMatchObject({ status: "canceled", errorKind: "canceled" });
  });

  it("doesn't start the brain again once the turn is stopped between tries", async () => {
    await start();
    // Claude rejects a tool, and Stop lands while Jarvis raises the alert about it, before it
    // tries again without the tool.
    brain.fail(rejectTool("task_create"));
    await chat("hi");
    await h.engine.processAvailable();
    const turn = await h.runner.claimNext();
    before("inbox.notify", () => h.runner.cancel(turn!.id));
    await h.runner.run(turn!);
    expect(brain.requests).toHaveLength(1);
    expect((await turns())[0]).toMatchObject({ status: "canceled", errorKind: "canceled" });
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

describe("Jarvis stopping (an update or a restart)", () => {
  /** What conversations were told, notices and errors, in order. */
  const told = async () =>
    (
      await h.tdb.db
        .select()
        .from(conversationLog)
        .where(inArray(conversationLog.kind, ["notice", "error"]))
        .orderBy(asc(conversationLog.idx))
    ).map((l) => String(l.payload.message ?? l.payload.text));

  /**
   * Starts a turn whose brain never finishes and ignores its signal, like a long deep-lane one,
   * and resolves once the brain is running, with the runner still draining (in an object: an
   * async function returning the promise itself would wait for it).
   */
  async function thinkingForever(alsoRun?: (req: BrainRequest) => void) {
    let thinking = () => {};
    const started = new Promise<void>((r) => {
      thinking = r;
    });
    script.run = (req) =>
      new Promise(() => {
        alsoRun?.(req);
        thinking();
      });
    await chat("hi");
    await h.engine.processAvailable();
    const draining = h.runner.drain();
    // A turn that ends before the brain starts (a setup error, say) fails here, not at the timeout.
    if ((await Promise.race([started, draining.then(() => "ended")])) === "ended") {
      const [t] = await turns();
      throw new Error(`The turn ended before the brain started (${t?.status}: ${t?.error})`);
    }
    return { draining };
  }

  it("ends a running turn at once, and leaves it for the next start without calling it stopped", async () => {
    await start();
    const { draining } = await thinkingForever();
    h.runner.stops.interruptAll();
    await draining;
    // Nobody pressed Stop and nothing failed: the turn waits for the next start.
    expect((await turns())[0]).toMatchObject({ status: "running", errorKind: null });
    expect(await told()).toEqual([]);

    await h.runner.recoverInterrupted();
    expect((await turns())[0]).toMatchObject({ status: "queued", errorKind: "interrupted" });
    expect(await told()).toEqual(["Pip restarted, so it's starting this again."]);
  });

  it("never starts the brain for a turn claimed just as Jarvis stops", async () => {
    await start();
    await chat("hi");
    await h.engine.processAvailable();
    const turn = await h.runner.claimNext();
    h.runner.stops.interruptAll();
    await h.runner.run(turn!);
    expect(script.requests).toHaveLength(0);
    expect((await turns())[0]).toMatchObject({ status: "running", errorKind: null });
  });

  it("lets a tool that was running finish, for as long as it's given", async () => {
    await start();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    before("task.create", () => gate);
    const { draining } = await thinkingForever((req) => {
      void req.tools.find((t) => t.name === "task_create")!.run({ title: "Book dentist" });
    });
    h.runner.stops.interruptAll();
    await draining;
    // Out of time, it stops waiting, whatever the tool is doing.
    await h.runner.stops.settled(20);
    expect(await tasks()).toHaveLength(0);
    release();
    await h.runner.stops.settled(5_000);
    expect(await tasks()).toHaveLength(1);
    // It had used a tool, so the next start says it was cut short rather than run it again.
    await h.runner.recoverInterrupted();
    expect((await turns())[0]).toMatchObject({ status: "failed", errorKind: "interrupted" });
  });

  it("still records the owner's Stop as stopped", async () => {
    await start();
    const { draining } = await thinkingForever();
    const [turn] = await turns();
    h.runner.cancel(turn!.id);
    h.runner.stops.interruptAll();
    await draining;
    expect((await turns())[0]).toMatchObject({ status: "canceled", errorKind: "canceled" });
  });
});
