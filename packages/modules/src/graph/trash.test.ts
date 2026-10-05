// The trash: a record goes with its subtasks, subpages and comments, and comes back with exactly
// what went with it. The Trash view shows one row per thing you trashed.
import { entity } from "@hearth/db";
import { integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import type { TrashRow } from "./trash.ts";

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
const live = async (ids: string[]) =>
  (
    await t.tdb.db
      .select({ id: entity.id, deletedAt: entity.deletedAt })
      .from(entity)
      .where(inArray(entity.id, ids))
  )
    .filter((r) => r.deletedAt === null)
    .map((r) => r.id)
    .sort();

describe("the trash", () => {
  it("takes a task's subtasks and comments with it, and brings them back", async () => {
    const parent = await ok<{ id: string }>("task.create", { title: "Plan the move" });
    const sub = await ok<{ id: string }>("task.create", { title: "Boxes", parentId: parent.id });
    const comment = await ok<{ id: string }>("comment.create", {
      parentId: sub.id,
      body: "Ask the shop",
    });
    t.clock.advance(1000);
    const gone = await ok<{ withIt: number }>("entity.trash", { id: parent.id });
    expect(gone.withIt).toBe(2);
    expect(await live([parent.id, sub.id, comment.id])).toEqual([]);
    const listed = await ok<{ id: string }[]>("task.list", { includeClosed: true });
    expect(listed.map((x) => x.id)).not.toContain(parent.id);

    t.clock.advance(1000);
    const back = await ok<{ withIt: number }>("entity.restore", { id: parent.id });
    expect(back.withIt).toBe(2);
    expect(await live([parent.id, sub.id, comment.id])).toEqual(
      [parent.id, sub.id, comment.id].sort(),
    );
  });

  it("brings back only what went with it, not what was trashed under it before", async () => {
    const parent = await ok<{ id: string }>("task.create", { title: "Garden" });
    const early = await ok<{ id: string }>("task.create", { title: "Seeds", parentId: parent.id });
    const later = await ok<{ id: string }>("task.create", { title: "Soil", parentId: parent.id });
    t.clock.advance(1000);
    await ok("entity.trash", { id: early.id });
    t.clock.advance(1000);
    await ok("entity.trash", { id: parent.id });
    t.clock.advance(1000);
    await ok("entity.restore", { id: parent.id });
    expect(await live([parent.id, early.id, later.id])).toEqual([parent.id, later.id].sort());
  });

  it("leaves mail under a record alone: its sync owns it", async () => {
    const thread = await ok<{ id: string }>("note.create", { title: "Holder" });
    const [mail] = await t.tdb.db
      .insert(entity)
      .values({
        id: crypto.randomUUID(),
        type: "email",
        title: "Hi",
        parentId: thread.id,
        createdBy: "integration:google",
        updatedBy: "integration:google",
      })
      .returning();
    t.clock.advance(1000);
    await ok("entity.trash", { id: thread.id });
    expect(await live([mail!.id])).toEqual([mail!.id]);
  });

  it("lists one row per thing trashed, newest first, counting what went with it", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Old idea" });
    const parent = await ok<{ id: string }>("task.create", { title: "Trip" });
    await ok("task.create", { title: "Tickets", parentId: parent.id });
    const mail = await t.tdb.db
      .insert(entity)
      .values({
        id: crypto.randomUUID(),
        type: "email_thread",
        title: "Synced",
        createdBy: "integration:google",
        updatedBy: "integration:google",
        deletedAt: t.clock.now(),
      })
      .returning();
    t.clock.advance(1000);
    await ok("entity.trash", { id: note.id });
    t.clock.advance(1000);
    await ok("entity.trash", { id: parent.id });
    const rows = await ok<TrashRow[]>("entity.trashed", {});
    expect(rows.map((r) => [r.title, r.withIt])).toEqual([
      ["Trip", 1],
      ["Old idea", 0],
    ]);
    expect(rows.map((r) => r.id)).not.toContain(mail[0]!.id);
    expect(rows[0]).toMatchObject({ type: "task", deletedBy: "owner" });
  });

  it("refuses to trash what's already in the trash", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Twice" });
    await ok("entity.trash", { id: note.id });
    const again = await t.kernel.execute("entity.trash", { id: note.id }, ownerCaller());
    expect(again).toMatchObject({ status: "error", code: "not_found" });
  });

  it("keeps your memory notes out of an integration's trash, and out of Jarvis's reach after outside content", async () => {
    const memory = await ok<{ id: string }>("memory.remember", {
      title: "Banking",
      body: "The owner banks with First Union.",
    });
    const note = await ok<{ id: string }>("note.create", { title: "Old idea" });
    t.clock.advance(1000);
    // Trashed in the same moment, so the note's row could count the memory note as going with it.
    await ok("entity.trash", { id: memory.id });
    await ok("entity.trash", { id: note.id });
    const outside = integrationCaller("google");
    const listed = await ok<TrashRow[]>("entity.trashed", {}, outside);
    expect(listed.map((r) => [r.title, r.withIt])).toEqual([["Old idea", 0]]);
    const back = await t.kernel.execute("entity.restore", { id: memory.id }, outside);
    expect(back).toMatchObject({ status: "error", code: "not_found" });
    // Memory back from the trash steers every turn again, so Jarvis can't after outside content.
    const planted = await t.kernel.execute(
      "entity.restore",
      { id: memory.id },
      jarvisCaller("untrusted"),
    );
    expect(planted).toMatchObject({ status: "error", code: "forbidden" });
    expect(await live([memory.id])).toEqual([]);
    await ok("entity.restore", { id: memory.id }, jarvisCaller("agent"));
    expect(await live([memory.id])).toEqual([memory.id]);
  });

  it("undoes a Notion import, and brings the whole import back from its page", async () => {
    const home = await ok<{ id: string }>(
      "note.create",
      { title: "Imported from Notion (2026-10-04)" },
      integrationCaller("notion"),
    );
    const page = await ok<{ id: string }>(
      "note.create",
      { title: "Trip", parentId: home.id },
      integrationCaller("notion"),
    );
    const imports = await ok<{ id: string; trashedAt: string | null }[]>("notion.imports", {});
    expect(imports).toMatchObject([{ id: home.id, trashedAt: null }]);
    t.clock.advance(1000);
    await ok("notion.undo_import", { id: home.id });
    expect(await live([home.id, page.id])).toEqual([]);
    const listed = await ok<TrashRow[]>("entity.trashed", {});
    expect(listed.map((r) => [r.id, r.withIt])).toEqual([[home.id, 1]]);
    t.clock.advance(1000);
    await ok("entity.restore", { id: home.id });
    expect(await live([home.id, page.id])).toEqual([home.id, page.id].sort());
    const [row] = await t.tdb.db.select().from(entity).where(eq(entity.id, page.id));
    expect(row!.deletedAt).toBeNull();
  });
});

describe("conversations", () => {
  it("can be renamed and found by their title", async () => {
    const c = await ok<{ id: string }>("conversation.create", { title: "New conversation" });
    await ok("conversation.create", { title: "Something else" });
    await ok("conversation.rename", { id: c.id, title: "Kitchen 50% plan" });
    const found = await ok<{ id: string; title: string }[]>("conversation.list", {
      query: "50%",
    });
    expect(found).toMatchObject([{ id: c.id, title: "Kitchen 50% plan" }]);
    expect(await ok<unknown[]>("conversation.list", { query: "nothing like it" })).toEqual([]);
  });
});
