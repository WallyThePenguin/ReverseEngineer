import { entity, heartbeatItem, jarvisTurn, notification } from "@hearth/db";
import { newId, ownerCaller, setSetting, systemCaller } from "@hearth/kernel";
import type { TaskView } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
});
afterEach(() => h.destroy());

async function ok<T>(name: string, input: unknown, caller = ownerCaller()): Promise<T> {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const inbox = (kind: string) =>
  h.tdb.db.select().from(notification).where(eq(notification.kind, kind));
const turns = () => h.tdb.db.select().from(jarvisTurn);

describe("Jarvis takes initiative", () => {
  it("warns before a deadline, without a model turn, once", async () => {
    await ok<TaskView>("task.create", {
      title: "Submit expense report",
      dueAt: "2026-10-02T18:00:00Z",
    });
    await h.settle();
    expect(await inbox("task.due_soon")).toEqual([]);
    h.clock.set("2026-10-01T18:00:30Z"); // 24 hours before
    await h.settle();
    const [n] = await inbox("task.due_soon");
    expect(n).toMatchObject({
      urgency: "interrupt",
      title: expect.stringContaining("Submit expense report"),
    });
    expect(n?.deliveredAt).not.toBeNull();
    expect(h.brain.requests).toHaveLength(0);
    await h.settle();
    expect(await inbox("task.due_soon")).toHaveLength(1);
  });

  it("offers checklist items as tasks once a note has settled", async () => {
    const note = await ok<{ id: string }>("note.create", {
      title: "Move",
      body: "- [ ] forward mail",
    });
    await ok("note.update", { id: note.id, body: "- [ ] forward mail\n- [ ] cancel internet" });
    await h.settle();
    h.clock.advance(11 * 60_000);
    await h.settle();
    const offers = await inbox("suggestion.checklist_tasks");
    expect(offers).toMatchObject([
      { title: 'Turn 2 unchecked items in "Move" into tasks?', urgency: "quiet" },
    ]);
  });

  it("writes the morning brief with a model turn, from every module's digest", async () => {
    await ok("task.create", { title: "Call the bank", dueAt: "2026-10-02T15:00:00Z" });
    h.brain.next(async (req) => {
      expect(req.prompt).toContain("Due today: T-1 Call the bank");
      return [
        {
          call: "brief_publish",
          input: { markdown: "Good morning. Call the bank at 11 a.m.", date: "2026-10-02" },
        },
        { say: "" },
      ];
    });
    h.clock.set("2026-10-02T12:15:10Z"); // Friday 8:15 a.m.
    await h.settle();
    const [brief] = await h.tdb.db.select().from(entity).where(eq(entity.type, "brief"));
    expect(brief).toMatchObject({ title: "Brief for 2026-10-02", createdBy: "jarvis" });
    expect(await inbox("brief")).toHaveLength(1);
    expect((await turns()).find((t) => t.trigger === "routine")).toMatchObject({
      mode: "proactive",
      outcome: "act",
    });
  });

  it("still publishes a plain brief while paused, without spending a turn", async () => {
    await ok("jarvis.pause", {});
    h.clock.set("2026-10-02T12:15:10Z");
    await h.settle();
    const [brief] = await h.tdb.db.select().from(entity).where(eq(entity.type, "brief"));
    expect(brief?.body).toContain("Brief for 2026-10-02 8:15 a.m.");
    expect(h.brain.requests).toHaveLength(0);
    expect(await turns()).toMatchObject([{ status: "skipped", skipReason: "paused" }]);
  });

  it("keeps answering you while paused", async () => {
    await ok("jarvis.pause", {});
    h.brain.next([{ say: "Still here." }]);
    await ok("chat.send", { text: "you there?" });
    await h.settle();
    expect((await turns())[0]).toMatchObject({ trigger: "chat", status: "done" });
  });

  it("stops spending proactive turns when the daily budget is used up", async () => {
    await setSetting(h.tdb.db, "jarvis.proactiveTurnsPerDay", 0);
    h.clock.set("2026-10-02T12:15:10Z");
    await h.settle();
    expect(h.brain.requests).toHaveLength(0);
    expect(await turns()).toMatchObject([{ status: "skipped", skipReason: "budget" }]);
    expect(await h.tdb.db.select().from(entity).where(eq(entity.type, "brief"))).toHaveLength(1);
  });

  it("spends one heartbeat turn on everything set aside, and none when nothing was", async () => {
    h.clock.set("2026-10-01T14:25:30Z");
    await h.settle();
    expect(h.brain.requests).toHaveLength(0);
    await h.tdb.db.insert(heartbeatItem).values([
      { id: newId(), text: "A newsletter arrived" },
      { id: newId(), text: "A PR was opened" },
    ]);
    h.brain.next([
      { call: "jarvis_observe", input: { kind: "fyi", text: "Nothing urgent." } },
      { say: "" },
    ]);
    h.clock.set("2026-10-01T14:50:30Z");
    await h.settle();
    expect(h.brain.requests).toHaveLength(1);
    expect(h.brain.requests[0]?.prompt).toContain("A PR was opened");
    expect((await turns())[0]).toMatchObject({ outcome: "note", lane: "fast" });
    h.clock.set("2026-10-01T15:15:30Z");
    await h.settle();
    expect(h.brain.requests).toHaveLength(1);
  });

  it("alerts you when a backup fails, even while paused", async () => {
    await ok("jarvis.pause", {});
    await ok(
      "system.backup_finished",
      { ok: false, detail: "rclone: token expired" },
      systemCaller(),
    );
    await h.settle();
    expect(await inbox("system.alert")).toMatchObject([
      { title: "Last night's backup failed", body: "rclone: token expired" },
    ]);
  });
});
