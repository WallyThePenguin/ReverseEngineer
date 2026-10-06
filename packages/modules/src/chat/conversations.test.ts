// The list of conversations with Jarvis: your chats and record threads, without the runs of its
// own routines (the brief, prep, drafting) unless you ask for those too.
import { jarvisTurn } from "@hearth/db";
import { jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown, caller = ownerCaller()): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
/** A turn Jarvis ran in a conversation, as the runner leaves it. */
const ran = (conversationId: string, mode: "reactive" | "proactive") =>
  t.tdb.db.insert(jarvisTurn).values({
    id: newId(),
    trigger: mode === "proactive" ? "routine" : "chat",
    mode,
    lane: "fast",
    origin: "agent",
    prompt: ".",
    conversationId,
    status: "done",
  });
const listed = async (input: Record<string, unknown> = {}) =>
  (await ok<{ id: string }[]>("conversation.list", input)).map((c) => c.id).sort();

describe("conversation.list", () => {
  it("leaves Jarvis's routine runs out unless asked, and keeps your chats and record threads", async () => {
    const jarvis = jarvisCaller("agent");
    const chat = (await ok<{ conversationId: string }>("chat.send", { text: "Plan the week" }))
      .conversationId;
    await ran(chat, "reactive");
    // Nothing in it yet: you just started it.
    const fresh = (await ok<{ id: string }>("conversation.create", {})).id;
    const brief = (await ok<{ id: string }>("conversation.create", { title: "Brief" }, jarvis)).id;
    await ran(brief, "proactive");
    // You answered a routine's run, so it's a chat now.
    const answered = (await ok<{ id: string }>("conversation.create", { title: "Prep" }, jarvis))
      .id;
    await ran(answered, "proactive");
    await ran(answered, "reactive");
    // A record's thread stays, even when only Jarvis has written in it.
    const task = await ok<{ id: string }>("task.create", { title: "Boxes" });
    const thread = (
      await ok<{ id: string }>(
        "conversation.create",
        { title: "Thread: Boxes", subjectId: task.id },
        jarvis,
      )
    ).id;
    await ran(thread, "proactive");

    expect(await listed()).toEqual([chat, fresh, answered, thread].sort());
    expect(await listed({ routines: true })).toEqual([chat, fresh, brief, answered, thread].sort());
    expect(await listed({ query: "brief" })).toEqual([]);
    expect(await listed({ query: "brief", routines: true })).toEqual([brief]);
  });
});
