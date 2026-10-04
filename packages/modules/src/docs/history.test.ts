import { docCheckpoint, entity } from "@hearth/db";
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

type Version = { at: string | null; by: string[]; frontiers: { peer: string; counter: number }[] };
type History = { versions: Version[]; checkpoints: { id: string; name: string }[] };

describe("doc history", () => {
  it("lists versions with who wrote them, shows and restores one, and keeps checkpoints", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Plan", body: "first" });
    const a = new Screen(note.id);
    await a.sync();
    const cp = await ok<{ id: string }>("doc.checkpoint", { id: note.id, name: "Draft 1" });
    // Later edits, by you on a screen and by Jarvis.
    a.type(a.text.length, " second");
    await a.sync();
    const revision = (await t.tdb.db.select().from(entity).where(eq(entity.id, note.id)))[0]!
      .revision;
    await ok(
      "note.update",
      { id: note.id, body: "rewritten by Jarvis", revision },
      jarvisCaller("agent"),
    );
    const h = await ok<History>("doc.history", { id: note.id });
    expect(h.versions.length).toBeGreaterThanOrEqual(1);
    expect(new Set(h.versions.flatMap((v) => v.by))).toEqual(new Set(["owner", "jarvis"]));
    expect(h.checkpoints.map((c) => c.name)).toEqual(["Draft 1"]);
    const saved = await t.tdb.db.select().from(docCheckpoint).where(eq(docCheckpoint.id, cp.id));
    const draft = await ok<{ text: string }>("doc.version", {
      id: note.id,
      frontiers: saved[0]!.frontiers,
    });
    expect(draft.text).toBe("first");
    // Restoring is a new edit: the text goes back, and the later versions stay readable.
    await ok("doc.restore", { id: note.id, frontiers: saved[0]!.frontiers });
    expect(await body(note.id)).toBe("first");
    await a.sync();
    expect(a.text).toBe("first");
    const after = await ok<History>("doc.history", { id: note.id });
    const texts = await Promise.all(
      after.versions.map(
        async (v) =>
          (await ok<{ text: string }>("doc.version", { id: note.id, frontiers: v.frontiers })).text,
      ),
    );
    expect(texts[0]).toBe("first");
    await ok("doc.checkpoint_delete", { id: cp.id });
    expect((await ok<History>("doc.history", { id: note.id })).checkpoints).toEqual([]);
  });

  it("splits editing sessions apart by time", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Log", body: "" });
    const a = new Screen(note.id);
    await a.sync();
    a.type(0, "morning");
    await a.sync();
    // An edit made an hour later, from another screen.
    const b = new Screen(note.id);
    await b.sync();
    b.doc.setRecordTimestamp(false);
    b.doc.getText("body").insert(7, " evening");
    b.doc.commit({ timestamp: Math.floor(Date.now() / 1000) + 3600 });
    await b.sync();
    const h = await ok<History>("doc.history", { id: note.id });
    const texts = await Promise.all(
      h.versions.map(
        async (v) =>
          (await ok<{ text: string }>("doc.version", { id: note.id, frontiers: v.frontiers })).text,
      ),
    );
    expect(texts.slice(0, 2)).toEqual(["morning evening", "morning"]);
  });

  it("names the writer of a note's text even before it's opened", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Plan", body: "mine" });
    await ok(
      "note.update",
      { id: note.id, body: "mine and theirs", revision: 1 },
      jarvisCaller("agent"),
    );
    await ok("note.update", { id: note.id, title: "Renamed" });
    const h = await ok<History>("doc.history", { id: note.id });
    expect(new Set(h.versions.flatMap((v) => v.by))).toEqual(new Set(["owner", "jarvis"]));
  });

  it("refuses versions the doc doesn't have, and other people", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "N", body: "x" });
    await new Screen(note.id).sync();
    expect(
      await t.kernel.execute(
        "doc.version",
        { id: note.id, frontiers: [{ peer: "123", counter: 99 }] },
        ownerCaller(),
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await t.kernel.execute(
        "doc.restore",
        { id: note.id, frontiers: [{ peer: "1", counter: 0 }] },
        jarvisCaller("agent"),
      ),
    ).toMatchObject({ status: "denied" });
    expect(
      await t.kernel.execute("doc.history", { id: note.id }, jarvisCaller("agent")),
    ).toMatchObject({ status: "denied" });
  });
});
