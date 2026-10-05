// Notes never lose a line to a whole-note write (D59): turning checklist items into tasks edits
// only those items, under the note's lock, and an agent rewriting a whole note must say which
// revision it read. A Notion import doesn't flood the inbox with checklist suggestions.
import { entity } from "@hearth/db";
import { jarvisCaller, ownerCaller, type ReadContext } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { notesModule } from "./index.ts";

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
const bodyOf = async (id: string) =>
  (await t.tdb.db.select().from(entity).where(eq(entity.id, id)))[0]!.body ?? "";

describe("checklist items into tasks", () => {
  it("waits for the note's lock and keeps a line written meanwhile", async () => {
    const note = await ok<{ id: string }>("note.create", {
      title: "Move",
      body: "- [ ] book movers\nnotes:",
    });
    let extracting: Promise<unknown> | undefined;
    await t.tdb.db.transaction(async (tx) => {
      // Someone else's write holds the note (a screen's sync, say)...
      const [row] = await tx.select().from(entity).where(eq(entity.id, note.id)).for("update");
      extracting = t.kernel.execute("note.extract_tasks", { id: note.id }, ownerCaller());
      await new Promise((r) => setTimeout(r, 300));
      // ...and adds a line while the extraction waits for it.
      await tx
        .update(entity)
        .set({ body: "- [ ] book movers\nnotes: ask about boxes", revision: row!.revision + 1 })
        .where(eq(entity.id, note.id));
    });
    expect(await extracting).toMatchObject({ status: "ok" });
    const body = await bodyOf(note.id);
    expect(body).toMatch(/^- \[ \] <m-ref type="task" id="[^"]+">book movers<\/m-ref>\n/);
    expect(body.endsWith("notes: ask about boxes")).toBe(true);
  });

  it("changes only the items it links, as one edit", async () => {
    const note = await ok<{ id: string }>("note.create", {
      title: "Week",
      body: "Intro 😀\n- [ ] call mom\n- [x] laundry\n- [ ] fix bike\nend",
    });
    const res = await ok<{ created: { id: string; title: string }[] }>("note.extract_tasks", {
      id: note.id,
      lines: [3],
    });
    expect(res.created.map((c) => c.title)).toEqual(["fix bike"]);
    const lines = (await bodyOf(note.id)).split("\n");
    expect(lines[0]).toBe("Intro 😀");
    expect(lines[1]).toBe("- [ ] call mom");
    expect(lines[3]).toBe(`- [ ] <m-ref type="task" id="${res.created[0]!.id}">fix bike</m-ref>`);
    expect(lines[4]).toBe("end");
  });
});

describe("whole-note rewrites", () => {
  it("make an agent say which revision it read", async () => {
    const note = await ok<{ id: string; revision: number }>("note.create", {
      title: "Plan",
      body: "one",
    });
    const jarvis = jarvisCaller("agent");
    const blind = await t.kernel.execute("note.update", { id: note.id, body: "two" }, jarvis);
    expect(blind).toMatchObject({ status: "error", code: "invalid_input" });
    // A rename alone, a rewrite that names its revision, and your own rewrite are all fine.
    await ok("note.update", { id: note.id, title: "Plan B" }, jarvis);
    const read = (await t.tdb.db.select().from(entity).where(eq(entity.id, note.id)))[0]!;
    await ok("note.update", { id: note.id, body: "two", revision: read.revision }, jarvis);
    await ok("note.update", { id: note.id, body: "three" });
    expect(await bodyOf(note.id)).toBe("three");
  });

  it("show Jarvis the revision to pass back when it reads the note", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Plan", body: "one" });
    await ok("note.update", { id: note.id, body: "two" });
    const read: ReadContext = { db: t.tdb.db, now: t.clock.now() };
    const seen = await notesModule.knowledge.note!(note.id, read);
    const revision = Number(/revision (\d+)/.exec(String(seen))?.[1]);
    expect(revision).toBe(2);
    await ok("note.update", { id: note.id, body: "three", revision }, jarvisCaller("agent"));
    expect(await bodyOf(note.id)).toBe("three");
  });
});

describe("checklist suggestions", () => {
  it("aren't offered for pages a Notion import wrote", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Trip", body: "- [ ] passport" });
    const created = (await t.events("entity.created")).find((e) => e.entityId === note.id)!;
    const offer = notesModule.reflexes.find((r) => r.name === "notes.offer_checklist_tasks")!;
    const read: ReadContext = { db: t.tdb.db, now: t.clock.now() };
    expect(await offer.run(created, read)).toHaveLength(1);
    expect(await offer.run({ ...created, actor: "integration:notion" }, read)).toEqual([]);
  });
});
