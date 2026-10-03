import { entity } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { LoroDoc, VersionVector } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

/** A screen with the doc open: its own Loro copy, synced through doc.sync. */
class Screen {
  doc = new LoroDoc();
  server: string | undefined;
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  get text() {
    return this.doc.getText("body").toString();
  }
  type(at: number, s: string) {
    this.doc.getText("body").insert(at, s);
    this.doc.commit();
  }
  async sync() {
    const from = this.server ? VersionVector.decode(Buffer.from(this.server, "base64")) : undefined;
    const update = from ? b64(this.doc.export({ mode: "update", from })) : undefined;
    const r = await ok<{ update: string; version: string }>("doc.sync", {
      id: this.id,
      version: this.server ? b64(this.doc.oplogVersion().encode()) : undefined,
      update,
    });
    this.doc.import(Buffer.from(r.update, "base64"));
    this.server = r.version;
  }
}
const body = async (id: string) =>
  (await t.tdb.db.select().from(entity).where(eq(entity.id, id)))[0]!.body;

describe("Jarvis as a co-editor", () => {
  it("edits part of a note in place, merging with typing it didn't see", async () => {
    const note = await ok<{ id: string; revision: number }>("note.create", {
      title: "Plan",
      body: "Goals\n- ship docs\n",
    });
    const a = new Screen(note.id);
    await a.sync();
    a.type(0, "# ");
    // Jarvis edits before the typing reaches Hearth.
    const r = await ok<{ changed: boolean }>(
      "doc.edit",
      {
        id: note.id,
        edits: [
          { find: "ship docs", replace: "ship live docs" },
          { after: "ship live docs\n", insert: "- test them\n" },
          { append: "Done by Friday." },
        ],
      },
      jarvisCaller("agent"),
    );
    expect(r.changed).toBe(true);
    await a.sync();
    expect(a.text).toBe("# Goals\n- ship live docs\n- test them\nDone by Friday.");
    expect(await body(note.id)).toBe(a.text);
    const h = await ok<{ versions: { by: string[] }[] }>("doc.history", { id: note.id });
    expect(h.versions.flatMap((v) => v.by)).toContain("jarvis");
  });

  it("refuses edits it can't place, stale revisions, and other records", async () => {
    const note = await ok<{ id: string; revision: number }>("note.create", {
      title: "N",
      body: "a b a",
    });
    const run = (input: object) => t.kernel.execute("doc.edit", input, jarvisCaller("agent"));
    expect(await run({ id: note.id, edits: [{ find: "zzz", replace: "y" }] })).toMatchObject({
      code: "invalid_input",
    });
    expect(await run({ id: note.id, edits: [{ find: "a", replace: "y" }] })).toMatchObject({
      code: "invalid_input",
    });
    expect(
      await run({ id: note.id, revision: note.revision + 5, edits: [{ append: "x" }] }),
    ).toMatchObject({ code: "conflict" });
    // A failed edit leaves the note as it was.
    expect(await body(note.id)).toBe("a b a");
    const task = await ok<{ id: string }>("task.create", { title: "T" });
    expect(await run({ id: task.id, edits: [{ append: "x" }] })).toMatchObject({
      code: "not_found",
    });
  });
});

describe("memory notes as docs", () => {
  it("syncs typing on the Memory page, keeping one version per stretch of typing", async () => {
    const m = await ok<{ id: string }>("memory.remember", {
      title: "Coffee",
      body: "Likes flat whites.",
    });
    const a = new Screen(m.id);
    await a.sync();
    a.type(a.text.length, " No sugar.");
    await a.sync();
    a.type(a.text.length, " Oat milk.");
    await a.sync();
    expect(await body(m.id)).toBe("Likes flat whites. No sugar. Oat milk.");
    const versions = await ok<{ revision: number; body: string }[]>("memory.history", {
      id: m.id,
    });
    expect(versions.map((v) => v.body)).toEqual([
      "Likes flat whites. No sugar. Oat milk.",
      "Likes flat whites.",
    ]);
    // Jarvis's change and a revert reach the open screen through the doc.
    await ok(
      "memory.update",
      { id: m.id, body: "Likes flat whites. No sugar. Oat milk. Decaf after 3." },
      jarvisCaller("agent"),
    );
    await a.sync();
    expect(a.text).toBe("Likes flat whites. No sugar. Oat milk. Decaf after 3.");
    await ok("memory.revert", { id: m.id, revision: 1 });
    await a.sync();
    expect(a.text).toBe("Likes flat whites.");
  });

  it("holds memory notes to their own length limit, and Jarvis can't doc-edit them", async () => {
    const m = await ok<{ id: string }>("memory.remember", { title: "Big", body: "" });
    const a = new Screen(m.id);
    await a.sync();
    a.type(0, "x".repeat(20_001));
    await expect(a.sync()).rejects.toThrow(/too long/);
    expect(
      await t.kernel.execute(
        "doc.edit",
        { id: m.id, edits: [{ append: "x" }] },
        jarvisCaller("agent"),
      ),
    ).toMatchObject({ code: "not_found" });
  });
});
