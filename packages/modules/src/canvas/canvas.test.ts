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
});
