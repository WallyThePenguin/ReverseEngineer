import { docUpdate, entity } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { count, eq } from "drizzle-orm";
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

describe("live docs", () => {
  it("keeps every screen's edits, made at once or offline", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Plan", body: "Hello" });
    const a = new Screen(note.id);
    const b = new Screen(note.id);
    await a.sync();
    await b.sync();
    expect([a.text, b.text]).toEqual(["Hello", "Hello"]);
    a.type(5, " world");
    b.type(0, "> ");
    await a.sync();
    await b.sync();
    await a.sync();
    expect(a.text).toBe("> Hello world");
    expect(b.text).toBe("> Hello world");
    expect(await body(note.id)).toBe("> Hello world");
  });

  it("merges Jarvis's change with typing it didn't see, instead of overwriting it", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Plan", body: "one\ntwo\n" });
    const a = new Screen(note.id);
    await a.sync();
    a.type(a.text.length, "three\n");
    // Jarvis read the note before the typing synced.
    await ok("note.update", { id: note.id, body: "ONE\ntwo\n" }, jarvisCaller("agent"));
    await a.sync();
    expect(a.text).toBe("ONE\ntwo\nthree\n");
    expect(await body(note.id)).toBe("ONE\ntwo\nthree\n");
    // A stale revision fails cleanly rather than undoing the typing.
    const stale = await t.kernel.execute(
      "note.update",
      { id: note.id, body: "x", revision: 1 },
      jarvisCaller("agent"),
    );
    expect(stale).toMatchObject({ status: "error", code: "conflict" });
  });

  it("folds updates into the snapshot without losing text or history", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Log", body: "" });
    const a = new Screen(note.id);
    await a.sync();
    let early: ReturnType<LoroDoc["frontiers"]> = [];
    for (let n = 0; n < 60; n++) {
      a.type(a.text.length, `${n} `);
      await a.sync();
      if (n === 9) early = a.doc.frontiers();
    }
    const [{ n } = { n: 0 }] = await t.tdb.db
      .select({ n: count() })
      .from(docUpdate)
      .where(eq(docUpdate.entityId, note.id));
    expect(n).toBeLessThan(50);
    const late = new Screen(note.id);
    await late.sync();
    expect(late.text).toBe(a.text);
    late.doc.checkout(early);
    expect(late.text).toBe("0 1 2 3 4 5 6 7 8 9 ");
  });

  it("refuses what isn't a doc, garbage updates, and Jarvis syncing", async () => {
    const task = await ok<{ id: string }>("task.create", { title: "T" });
    expect(await t.kernel.execute("doc.sync", { id: task.id }, ownerCaller())).toMatchObject({
      code: "not_found",
    });
    const note = await ok<{ id: string }>("note.create", { title: "N" });
    expect(
      await t.kernel.execute("doc.sync", { id: note.id, update: "AAAA" }, ownerCaller()),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await t.kernel.execute("doc.sync", { id: note.id }, jarvisCaller("agent")),
    ).toMatchObject({ status: "denied" });
  });
});
