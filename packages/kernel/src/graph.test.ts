import { JARVIS_ENTITY_ID, renderMention } from "@hearth/core";
import { link, notification } from "@hearth/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { jarvisCaller, ownerCaller, systemCaller } from "./callers.ts";
import { getCursor, latestSeq, readEventsAfter, setCursor } from "./events.ts";
import { createEntity, updateEntity } from "./graph.ts";
import { createNotification } from "./notify.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";
import { defineAction, defineModule } from "./types.ts";

const notes = defineModule({
  name: "notes",
  description: "test notes",
  entityTypes: ["note"],
  events: [],
  knowledge: { note: async () => "note" },
  reflexes: [],
  noReflexesBecause: "test",
  actions: [
    defineAction({
      name: "note.create",
      description: "Create a note for tests",
      input: z.object({ title: z.string(), body: z.string().optional() }),
      risk: "internal",
      handler: (i, ctx) =>
        createEntity(ctx, { type: "note", title: i.title, body: i.body ?? null }),
    }),
    defineAction({
      name: "note.edit",
      description: "Edit a note for tests",
      input: z.object({ id: z.string(), body: z.string(), revision: z.number().optional() }),
      risk: "internal",
      handler: (i, ctx) =>
        updateEntity(ctx, i.id, { body: i.body }, { expectedRevision: i.revision }),
    }),
    defineAction({
      name: "test.interrupt",
      description: "Create an interrupt for tests",
      input: z.object({ key: z.string(), deadline: z.string().optional() }),
      risk: "internal",
      handler: (i, ctx) =>
        createNotification(ctx, {
          kind: "test",
          title: i.key,
          urgency: "interrupt",
          dedupeKey: i.key,
          deadline: i.deadline ? new Date(i.deadline) : null,
        }),
    }),
  ],
});

type Row = { id: string; revision: number };
let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([notes]);
});
afterAll(() => t.destroy());

async function create(title: string, body?: string): Promise<Row> {
  const res = await t.kernel.execute<Row>("note.create", { title, body }, ownerCaller());
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
}

describe("mention sync", () => {
  it("derives links both ways and tells Jarvis when it is mentioned", async () => {
    const target = await create("Groceries");
    const jarvis = renderMention({ type: "agent", id: JARVIS_ENTITY_ID, label: "Jarvis" });
    const ref = renderMention({ type: "note", id: target.id, label: "Groceries" });
    const src = await create("Plan", `See ${ref}.\n\n${jarvis} please add milk.`);

    const out = await t.tdb.db.select().from(link).where(eq(link.fromId, src.id));
    expect(out.map((l) => [l.toId, l.anchor]).sort()).toEqual(
      [
        [JARVIS_ENTITY_ID, "#0"],
        [target.id, "#0"],
      ].sort(),
    );
    const back = await t.tdb.db.select().from(link).where(eq(link.toId, target.id));
    expect(back.map((l) => l.fromId)).toEqual([src.id]);

    const [mentioned] = await t.events("jarvis.mentioned");
    expect(mentioned).toMatchObject({
      entityId: src.id,
      actor: "owner",
      origin: "owner",
      payload: { anchor: "#0", type: "note", context: "@Jarvis please add milk." },
    });

    // Editing other text doesn't re-trigger; a second @Jarvis does; removing a mention unlinks.
    const body2 = `Nothing linked now.\n\n${jarvis} please add milk.\n\n${jarvis} and eggs?`;
    const edit = await t.kernel.execute(
      "note.edit",
      { id: src.id, body: body2, revision: 1 },
      ownerCaller(),
    );
    expect(edit.status).toBe("ok");
    const mentions = await t.events("jarvis.mentioned");
    expect(mentions.map((e) => e.payload.anchor)).toEqual(["#0", "#1"]);
    expect(mentions[1]?.payload.context).toBe("@Jarvis and eggs?");
    expect((await t.events("link.removed")).map((e) => e.payload.toId)).toEqual([target.id]);
  });

  it("rejects a stale revision", async () => {
    const n = await create("Rev");
    await t.kernel.execute("note.edit", { id: n.id, body: "a" }, ownerCaller());
    expect(
      await t.kernel.execute("note.edit", { id: n.id, body: "b", revision: 1 }, ownerCaller()),
    ).toMatchObject({
      code: "conflict",
    });
  });

  it("ignores mentions of records that don't exist", async () => {
    const ghost = renderMention({
      type: "note",
      id: "018f0000-0000-7000-8000-000000000000",
      label: "x",
    });
    const n = await create("Ghost", ghost);
    expect(await t.tdb.db.select().from(link).where(eq(link.fromId, n.id))).toEqual([]);
  });

  it("marks Jarvis-written mentions with Jarvis as the actor", async () => {
    const jarvis = renderMention({ type: "agent", id: JARVIS_ENTITY_ID, label: "Jarvis" });
    await t.kernel.execute("note.create", { title: "Self", body: jarvis }, jarvisCaller("owner"));
    expect((await t.events("jarvis.mentioned")).at(-1)?.actor).toBe("jarvis");
  });
});

describe("event log", () => {
  it("reads in order after a cursor", async () => {
    const before = await latestSeq(t.tdb.db);
    await Promise.all([create("A"), create("B"), create("C")]);
    const after = await readEventsAfter(t.tdb.db, before);
    expect(after.filter((e) => e.kind === "entity.created")).toHaveLength(3);
    expect(after.map((e) => e.seq)).toEqual([...after.map((e) => e.seq)].sort((a, b) => a - b));
    await setCursor(t.tdb.db, "test", after.at(-1)!.seq);
    expect(await getCursor(t.tdb.db, "test")).toBe(after.at(-1)!.seq);
    expect(await getCursor(t.tdb.db, "nobody")).toBe(0);
  });
});

describe("interrupt budget", () => {
  it("delivers eight a day, then holds all but urgent ones", async () => {
    for (let i = 0; i < 8; i++) {
      await t.kernel.execute("test.interrupt", { key: `i${i}` }, systemCaller());
    }
    await t.kernel.execute("test.interrupt", { key: "i8" }, systemCaller());
    await t.kernel.execute(
      "test.interrupt",
      { key: "urgent", deadline: "2026-10-01T20:00:00Z" },
      systemCaller(),
    );
    const again = await t.kernel.execute("test.interrupt", { key: "i8" }, systemCaller());
    expect(again).toEqual({ status: "ok", result: null });
    const rows = await t.tdb.db.select().from(notification).where(eq(notification.kind, "test"));
    const byKey = Object.fromEntries(rows.map((r) => [r.dedupeKey, r]));
    expect(rows.filter((r) => r.deliveredAt)).toHaveLength(9);
    expect(byKey.i8).toMatchObject({ deliveredAt: null, deferredReason: "budget_spent" });
    expect(byKey.urgent?.deliveredAt).not.toBeNull();
  });
});
