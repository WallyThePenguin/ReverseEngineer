import { type Canvas, mergeCanvas } from "@hearth/core";
import { entity, link } from "@hearth/db";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { and, eq } from "drizzle-orm";
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

interface Board {
  title: string;
  version: number;
  board: { nodes: { id: string; type: string; label?: string; text?: string }[]; edges: [] };
}

describe("canvas boards", () => {
  it("saves a board whole, links the records on it, and lets Jarvis add cards", async () => {
    const { id } = await ok<{ id: string }>("canvas.create", { title: "Launch" });
    const task = await ok<{ id: string }>("task.create", { title: "Write the post" });
    const board = {
      nodes: [{ id: "n1", type: "text", text: "Goals", x: 0, y: 0, width: 200, height: 80 }],
      edges: [],
    };
    expect(await ok("canvas.save", { id, board })).toEqual({ id, version: 1 });

    // Jarvis adds a card for the task and a note below.
    const added = await ok<{ ids: string[] }>(
      "canvas.add",
      { id, cards: [{ recordId: task.id }, { text: "Ask Sam for numbers" }] },
      jarvisCaller("owner"),
    );
    expect(added.ids).toHaveLength(2);
    const got = await ok<Board>("canvas.get", { id });
    expect(got.version).toBe(2);
    expect(got.board.nodes.map((n) => n.label ?? n.text)).toEqual([
      "Goals",
      "Write the post",
      "Ask Sam for numbers",
    ]);

    // The task's card is a link, so the task lists the board as a backlink.
    const links = await t.tdb.db
      .select()
      .from(link)
      .where(and(eq(link.fromId, id), eq(link.toId, task.id)));
    expect(links).toHaveLength(1);
    const [row] = await t.tdb.db.select().from(entity).where(eq(entity.id, id));
    expect(row?.body).toContain("Goals");

    expect(
      await t.kernel.execute(
        "canvas.save",
        { id, board: { nodes: [{ id: "x", type: "video" }] } },
        ownerCaller(),
      ),
    ).toMatchObject({ status: "error", code: "invalid_input" });
    expect(await ok<{ id: string }[]>("canvas.list")).toMatchObject([{ id }]);
  });

  it("refuses a save made from an old version, so the screen merges instead of erasing", async () => {
    const { id } = await ok<{ id: string }>("canvas.create", { title: "Plan" });
    const text = (n: string, t: string) => ({
      id: n,
      type: "text",
      text: t,
      x: 0,
      y: 0,
      width: 200,
      height: 80,
    });
    const v1 = { nodes: [text("a", "Goals")], edges: [] };
    expect(await ok("canvas.save", { id, board: v1, baseVersion: 0 })).toEqual({ id, version: 1 });
    // The screen edits from version 1 while Jarvis adds a card.
    await ok("canvas.add", { id, cards: [{ text: "From Jarvis" }] }, jarvisCaller("owner"));
    const mine = { nodes: [text("a", "Goals for Q4")], edges: [] };
    const stale = await t.kernel.execute(
      "canvas.save",
      { id, board: mine, baseVersion: 1 },
      ownerCaller(),
    );
    expect(stale).toMatchObject({ status: "error", code: "conflict" });
    const theirs = await ok<Board>("canvas.get", { id });
    const merged = mergeCanvas(v1 as Canvas, mine as Canvas, theirs.board as unknown as Canvas);
    await ok("canvas.save", { id, board: merged, baseVersion: theirs.version });
    const got = await ok<Board>("canvas.get", { id });
    expect(got.version).toBe(3);
    expect(got.board.nodes.map((n) => n.text)).toEqual(["Goals for Q4", "From Jarvis"]);
  });

  it("loses nothing when Jarvis adds cards while a screen saves", async () => {
    const { id } = await ok<{ id: string }>("canvas.create", { title: "Race" });
    const mine = {
      nodes: [{ id: "u", type: "text", text: "Mine", x: 0, y: 0, width: 200, height: 80 }],
      edges: [],
    };
    for (let round = 0; round < 5; round++) {
      const { version, board } = await ok<Board>("canvas.get", { id });
      const user = { nodes: [...board.nodes, { ...mine.nodes[0]!, id: `u${round}` }], edges: [] };
      const [saved] = await Promise.all([
        t.kernel.execute("canvas.save", { id, board: user, baseVersion: version }, ownerCaller()),
        ok("canvas.add", { id, cards: [{ text: `J${round}` }] }, jarvisCaller("owner")),
      ]);
      if (saved.status !== "ok") {
        // Jarvis got there first: merge the way the screen does, and save again.
        expect(saved).toMatchObject({ code: "conflict" });
        const now = await ok<Board>("canvas.get", { id });
        const merged = mergeCanvas(
          board as unknown as Canvas,
          user as unknown as Canvas,
          now.board as unknown as Canvas,
        );
        await ok("canvas.save", { id, board: merged, baseVersion: now.version });
      }
    }
    const end = await ok<Board>("canvas.get", { id });
    const texts = end.board.nodes.map((n) => n.text).sort();
    expect(texts).toEqual(["J0", "J1", "J2", "J3", "J4", "Mine", "Mine", "Mine", "Mine", "Mine"]);
    expect(end.version).toBeGreaterThanOrEqual(10);
  });

  it("makes Jarvis say which version it is saving over", async () => {
    const { id } = await ok<{ id: string }>("canvas.create", { title: "J" });
    const res = await t.kernel.execute(
      "canvas.save",
      { id, board: { nodes: [], edges: [] } },
      jarvisCaller("owner"),
    );
    expect(res).toMatchObject({ status: "error", code: "invalid_input" });
    await ok(
      "canvas.save",
      { id, board: { nodes: [], edges: [] }, baseVersion: 0 },
      jarvisCaller("owner"),
    );
  });
});
