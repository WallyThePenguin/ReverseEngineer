import { JARVIS_ENTITY_ID, renderMention } from "@hearth/core";
import { approval, entity, jarvisTurn } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import type { TaskView } from "@hearth/modules";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
beforeEach(async () => {
  h = await createJarvisHarness();
});
afterEach(() => h.destroy());

async function ok<T>(name: string, input: unknown): Promise<T> {
  const res = await h.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const jarvisMention = renderMention({ type: "agent", id: JARVIS_ENTITY_ID, label: "Jarvis" });
const comments = (parentId: string) =>
  h.tdb.db
    .select()
    .from(entity)
    .where(and(eq(entity.parentId, parentId), eq(entity.type, "comment")));
const turns = () => h.tdb.db.select().from(jarvisTurn);

describe("Jarvis reacts", () => {
  it("answers a chat message, using Hearth's tools, and logs the whole turn", async () => {
    h.brain.next([
      { call: "task_create", input: { title: "Book dentist" } },
      { say: "Added T-1, Book dentist." },
    ]);
    const { conversationId } = await ok<{ conversationId: string }>("chat.send", {
      text: "remind me to book the dentist",
    });
    await h.settle();

    const conv = await ok<{ log: { kind: string; payload: Record<string, unknown> }[] }>(
      "conversation.get",
      { id: conversationId },
    );
    expect(conv.log.map((l) => l.kind)).toEqual([
      "user_message",
      "turn_started",
      "tool_call",
      "tool_result",
      "assistant_message",
      "turn_finished",
    ]);
    const [task] = await ok<TaskView[]>("task.list", {});
    expect(task).toMatchObject({ title: "Book dentist", createdBy: "jarvis" });
    const [turn] = await turns();
    expect(turn).toMatchObject({
      trigger: "chat",
      mode: "reactive",
      status: "done",
      outcome: "act",
      reply: "Added T-1, Book dentist.",
    });
    expect(h.brain.requests[0]?.system).toContain("The owner is talking to you directly");
  });

  it("answers an @mention in a note as a comment on that note, without answering itself", async () => {
    h.brain.next([{ say: "Milk is on the list now." }]);
    const note = await ok<{ id: string }>("note.create", {
      title: "Groceries",
      body: `eggs\n\n${jarvisMention} add milk`,
    });
    await h.settle();
    const thread = await comments(note.id);
    expect(thread).toMatchObject([{ createdBy: "jarvis", body: "Milk is on the list now." }]);
    expect(h.brain.requests).toHaveLength(1);
    expect(h.brain.requests[0]?.system).toContain("# Groceries");
  });

  it("works a task assigned to it and reports on the task", async () => {
    h.brain.next(async (req) => {
      const id = req.system.match(/id: ([0-9a-f-]{36})/)![1]!;
      return [
        { call: "task_update", input: { id, status: "in_progress" } },
        { call: "task_update", input: { id, status: "in_review" } },
        { say: "Found three plumbers with openings this week; details in the note." },
      ];
    });
    const task = await ok<TaskView>("task.create", { title: "Find a plumber", assignee: "jarvis" });
    await h.settle();
    expect((await ok<TaskView>("task.get", { id: task.id })).status).toBe("in_review");
    expect(await comments(task.id)).toMatchObject([
      { createdBy: "jarvis", body: expect.stringContaining("three plumbers") },
    ]);

    // A follow-up comment on Jarvis's task gets a reply too.
    h.brain.next([{ say: "Booked the first one for Tuesday." }]);
    await ok("comment.create", { parentId: task.id, body: "Pick the cheapest one" });
    await h.settle();
    expect((await comments(task.id)).map((c) => c.createdBy)).toEqual([
      "jarvis",
      "owner",
      "jarvis",
    ]);
  });

  it("asks before doing something hard to undo, then picks up after you approve", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Old draft" });
    h.brain.next([
      { call: "entity_trash", input: { id: note.id } },
      { say: "I've asked to trash the old draft." },
    ]);
    await ok("chat.send", { text: "clean up the old draft" });
    await h.settle();
    const [pending] = await h.tdb.db.select().from(approval).where(eq(approval.status, "pending"));
    expect(pending).toMatchObject({ action: "entity.trash", requestedBy: "jarvis" });
    expect((await turns())[0]?.outcome).toBe("ask");

    h.brain.next([{ say: "Done, it's in the trash." }]);
    expect((await h.kernel.decideApproval(pending!.id, "approve", ownerCaller())).status).toBe(
      "ok",
    );
    await h.settle();
    const resumed = (await turns()).find((t) => t.trigger === "approval");
    expect(resumed).toMatchObject({
      status: "done",
      conversationId: (await turns())[0]?.conversationId,
    });
    expect(h.brain.requests.at(-1)?.prompt).toContain("approved and done");
  });

  it("acts when something it was asked to watch happens", async () => {
    const task = await ok<TaskView>("task.create", { title: "Passport renewal" });
    h.brain.next([
      {
        call: "jarvis_watch",
        input: {
          description: "Tell me when the passport task is done",
          filter: {
            and: [
              { field: "kind", op: "eq", value: "task.status_changed" },
              { field: "entityId", op: "eq", value: task.id },
            ],
          },
        },
      },
      { say: "Watching it." },
    ]);
    await ok("chat.send", { text: "let me know when the passport is done" });
    await h.settle();
    h.brain.next([
      { call: "inbox_notify", input: { title: "Passport renewal is done" } },
      { say: "" },
    ]);
    await ok("task.update", { id: task.id, status: "completed" });
    await h.settle();
    expect((await turns()).map((t) => [t.trigger, t.outcome])).toEqual([
      ["chat", "act"],
      ["watch", "tell"],
    ]);
  });

  it("treats the rest of a turn as untrusted after reading the web", async () => {
    const a = await ok<{ id: string }>("note.create", { title: "Scratch A" });
    const b = await ok<{ id: string }>("note.create", { title: "Scratch B" });
    await ok("standing_rule.create", { action: "entity.trash", note: "tidy freely" });
    // With your standing rule, Jarvis may trash without asking...
    h.brain.next([{ call: "entity_trash", input: { id: a.id } }, { say: "ok" }]);
    await ok("chat.send", { text: "tidy up A" });
    await h.settle();
    expect(await h.tdb.db.select().from(approval)).toEqual([]);
    // ...but not once the turn has read the web.
    h.brain.next([
      { readWeb: "WebFetch" },
      { call: "entity_trash", input: { id: b.id } },
      { say: "ok" },
    ]);
    await ok("chat.send", { text: "look this up, then tidy up B" });
    await h.settle();
    const [pending] = await h.tdb.db.select().from(approval).where(eq(approval.status, "pending"));
    expect(pending).toMatchObject({ action: "entity.trash", origin: "untrusted" });
  });
});
