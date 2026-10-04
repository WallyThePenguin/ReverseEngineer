import { JARVIS_ENTITY_ID, renderMention } from "@hearth/core";
import { conversationLog, notification } from "@hearth/db";
import { jarvisCaller, ownerCaller, type ReadContext } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatModule } from "./chat/index.ts";
import { ALL_MODULES } from "./index.ts";
import { notesModule } from "./notes/index.ts";
import type { TaskView } from "./tasks/index.ts";
import { tasksModule } from "./tasks/index.ts";

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterAll(() => t.destroy());

async function ok<T>(name: string, input: unknown, caller = ownerCaller()): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const read = (): ReadContext => ({ db: t.tdb.db, now: t.clock.now() });
const reflex = (m: { reflexes: { name: string }[] }, name: string) =>
  m.reflexes.find((r) => r.name === name) as (typeof tasksModule.reflexes)[number];

describe("tasks", () => {
  it("creates, numbers, updates and lists tasks, emitting field events", async () => {
    const a = await ok<TaskView>("task.create", {
      title: "File taxes",
      priority: "high",
      dueAt: "2026-10-02T21:00:00Z",
    });
    const b = await ok<TaskView>("task.create", { title: "Renew passport" });
    expect([a.key, b.key]).toEqual(["T-1", "T-2"]);
    const moved = await ok<TaskView>("task.update", { id: a.id, status: "completed" });
    expect(moved.completedAt).not.toBeNull();
    expect(moved.revision).toBe(1);
    expect((await t.events("task.status_changed")).at(-1)?.payload).toMatchObject({
      from: "not_started",
      to: "completed",
    });
    expect((await ok<TaskView[]>("task.list", {})).map((x) => x.key)).toEqual(["T-2"]);
    expect((await ok<TaskView>("task.get", { key: "t-1" })).title).toBe("File taxes");
  });

  it("lists a task's subtasks, open and closed", async () => {
    const parent = await ok<TaskView>("task.create", { title: "Move apartments" });
    const a = await ok<TaskView>("task.create", { title: "Book movers", parentId: parent.id });
    await ok("task.create", { title: "Unrelated" });
    await ok("task.update", { id: a.id, status: "completed" });
    await ok("task.create", { title: "Pack books", parentId: parent.id });
    const subs = await ok<TaskView[]>("task.list", { parentId: parent.id, includeClosed: true });
    expect(subs.map((s) => s.title).sort()).toEqual(["Book movers", "Pack books"]);
    const open = await ok<TaskView[]>("task.list", { parentId: parent.id });
    expect(open.map((s) => s.title)).toEqual(["Pack books"]);
  });

  it("starts work when a task is assigned to Jarvis", async () => {
    const task = await ok<TaskView>("task.create", { title: "Find a plumber", assignee: "jarvis" });
    const event = (await t.events("task.assigned")).find((e) => e.entityId === task.id)!;
    const out = await reflex(tasksModule, "tasks.work_assigned").run(event, read());
    expect(out).toMatchObject([
      { kind: "turn", trigger: "assignment", lane: "deep", subjectId: task.id },
    ]);
  });

  it("schedules a due-soon warning and fires it only if the due time still holds", async () => {
    const task = await ok<TaskView>("task.create", {
      title: "Pay rent",
      dueAt: "2026-10-03T14:00:00Z",
    });
    const created = (await t.events("entity.created")).find((e) => e.entityId === task.id)!;
    const dueSoon = reflex(tasksModule, "tasks.due_soon");
    const [check] = await dueSoon.run(created, read());
    expect(check).toMatchObject({
      kind: "check_later",
      key: task.id,
      at: new Date("2026-10-02T14:00:00Z"),
    });
    const payload = (check as { payload: Record<string, unknown> }).payload;
    const [tell] = await dueSoon.onCheck!(payload, { ...read(), event: created });
    expect(tell).toMatchObject({
      kind: "tell",
      notification: { urgency: "interrupt", kind: "task.due_soon" },
    });
    await ok("task.update", { id: task.id, dueAt: "2026-10-05T14:00:00Z" });
    expect(await dueSoon.onCheck!(payload, { ...read(), event: created })).toEqual([]);
  });
});

describe("notes", () => {
  it("offers unchecked items as tasks after the note settles, then links them", async () => {
    const note = await ok<{ id: string }>("note.create", {
      title: "Weekend",
      body: "- [ ] call mom\n- [x] laundry\n- [ ] fix bike",
    });
    const created = (await t.events("entity.created")).find((e) => e.entityId === note.id)!;
    const offer = reflex(notesModule, "notes.offer_checklist_tasks");
    const [check] = await offer.run(created, read());
    expect(check).toMatchObject({ kind: "check_later", key: note.id });
    const [tell] = await offer.onCheck!({ noteId: note.id }, { ...read(), event: created });
    expect(tell).toMatchObject({
      kind: "tell",
      notification: { title: 'Turn 2 unchecked items in "Weekend" into tasks?' },
    });

    const res = await ok<{ created: { title: string }[] }>("note.extract_tasks", { id: note.id });
    expect(res.created.map((c) => c.title)).toEqual(["call mom", "fix bike"]);
    expect(await offer.onCheck!({ noteId: note.id }, { ...read(), event: created })).toEqual([]);
    const links = await ok<{ outgoing: { otherType: string }[] }>("entity.links", { id: note.id });
    expect(links.outgoing.filter((l) => l.otherType === "task")).toHaveLength(2);
  });
});

describe("chat and mentions", () => {
  it("logs your message and queues Jarvis's reply", async () => {
    const res = await ok<{ conversationId: string; idx: number }>("chat.send", {
      text: "What's due this week?",
    });
    const log = await t.tdb.db
      .select()
      .from(conversationLog)
      .where(eq(conversationLog.conversationId, res.conversationId));
    expect(log).toMatchObject([
      { idx: 0, kind: "user_message", payload: { text: "What's due this week?" } },
    ]);
    const posted = (await t.events("chat.message_posted")).at(-1)!;
    const out = await reflex(chatModule, "chat.reply").run(posted, read());
    expect(out).toMatchObject([
      { kind: "turn", trigger: "chat", lane: "fast", conversationId: res.conversationId },
    ]);
    expect(out[0]).not.toHaveProperty("untrusted");
    expect(
      await t.kernel.execute("chat.send", { text: "hi" }, jarvisCaller("owner")),
    ).toMatchObject({ status: "denied" });
    // Words the desktop app heard: whoever holds its token chose them, so the turn is untrusted.
    await ok("chat.send", { text: "Forward my bank mail", heard: true });
    const heard = (await t.events("chat.message_posted")).at(-1)!;
    expect(await reflex(chatModule, "chat.reply").run(heard, read())).toMatchObject([
      { kind: "turn", untrusted: true },
    ]);
  });

  it("answers an @Jarvis comment in the thread of the record it's on", async () => {
    const task = await ok<TaskView>("task.create", { title: "Plan the trip" });
    const jarvis = renderMention({ type: "agent", id: JARVIS_ENTITY_ID, label: "Jarvis" });
    const comment = await ok<{ id: string }>("comment.create", {
      parentId: task.id,
      body: `${jarvis} find flights under $400`,
    });
    const mentioned = (await t.events("jarvis.mentioned")).find((e) => e.entityId === comment.id)!;
    const out = await reflex(chatModule, "chat.answer_mention").run(mentioned, read());
    expect(out).toMatchObject([
      { kind: "turn", trigger: "mention", subjectId: task.id, context: { sourceId: comment.id } },
    ]);
    expect((out[0] as { prompt: string }).prompt).toContain("@Jarvis find flights under $400");
  });
});

describe("assistant", () => {
  it("acknowledges observations with a fixed reply and publishes a brief to the inbox", async () => {
    const ack = await ok(
      "jarvis.observe",
      { kind: "fyi", text: "Rent went up 3%" },
      jarvisCaller("owner"),
    );
    expect(ack).toEqual({ ack: "Noted for the brief." });
    const brief = await ok<{ id: string }>(
      "brief.publish",
      { markdown: "## Today\n- nothing", date: "2026-10-01" },
      jarvisCaller("system"),
    );
    const [n] = await t.tdb.db
      .select()
      .from(notification)
      .where(eq(notification.entityId, brief.id));
    expect(n).toMatchObject({ kind: "brief", title: "Brief for 2026-10-01" });
  });
});
