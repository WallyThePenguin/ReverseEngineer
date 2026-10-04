import { approval, audit } from "@hearth/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { jarvisCaller, ownerCaller } from "./callers.ts";
import { ActionError } from "./errors.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";
import { type ActionContext, defineAction, defineModule } from "./types.ts";

// Actions that wait on the world (B1, 1.15): no transaction held while they wait, their events,
// audit row and approval recorded together after.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether the query runs in a transaction that started before it (an open one, held). */
async function heldOpen(ctx: ActionContext): Promise<boolean> {
  await ctx.tx.execute(sql`select 1`);
  await sleep(30);
  const res = await ctx.tx.execute<{ held: boolean }>(
    sql`select now() < statement_timestamp() as held`,
  );
  return Boolean(res.rows[0]?.held);
}

const waits = defineModule({
  name: "waits",
  description: "Test module",
  entityTypes: [],
  events: [{ kind: "waits.done", description: "Waited" }],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    defineAction({
      name: "waits.io",
      description: "Waits on the world",
      input: z.object({ fail: z.boolean().default(false) }),
      risk: "internal",
      io: true,
      async handler(i, ctx) {
        const held = await heldOpen(ctx);
        ctx.emit({ kind: "waits.done" });
        if (i.fail) throw new ActionError("failed", "The world said no.");
        return { held };
      },
    }),
    defineAction({
      name: "waits.tx",
      description: "Waits inside its transaction",
      input: z.object({}),
      risk: "internal",
      handler: async (_i, ctx) => ({ held: await heldOpen(ctx) }),
    }),
    defineAction({
      name: "waits.send",
      description: "Sends something, after a wait",
      input: z.object({ to: z.string() }),
      risk: "outward",
      io: true,
      async handler(i, ctx) {
        await sleep(10);
        ctx.emit({ kind: "waits.done", payload: { to: i.to } });
        return { sent: i.to };
      },
    }),
  ],
});

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([waits]);
});
afterAll(() => t.destroy());

describe("io actions", () => {
  it("hold no transaction while they wait, and record their events and audit after", async () => {
    expect(await t.kernel.execute("waits.tx", {}, jarvisCaller("owner"))).toEqual({
      status: "ok",
      result: { held: true },
    });
    const before = (await t.events("waits.done")).length;
    const res = await t.kernel.execute("waits.io", {}, jarvisCaller("owner"));
    expect(res).toEqual({ status: "ok", result: { held: false } });
    expect(await t.events("waits.done")).toHaveLength(before + 1);
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "waits.io"));
    expect(rows.map((r) => r.outcome)).toEqual(["ok"]);
  });

  it("leave no events behind when they fail, and audit the failure", async () => {
    const before = (await t.events("waits.done")).length;
    const res = await t.kernel.execute("waits.io", { fail: true }, jarvisCaller("owner"));
    expect(res).toEqual({ status: "error", code: "failed", message: "The world said no." });
    expect(await t.events("waits.done")).toHaveLength(before);
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "waits.io"));
    expect(rows.map((r) => r.outcome).sort()).toEqual(["error", "ok"]);
  });

  it("close their approval in the same record as their events", async () => {
    const asked = await t.kernel.execute("waits.send", { to: "ana" }, jarvisCaller("owner"));
    if (asked.status !== "pending_approval") throw new Error(JSON.stringify(asked));
    const done = await t.kernel.decideApproval(asked.approvalId, "approve", ownerCaller());
    expect(done).toEqual({ status: "ok", result: { sent: "ana" } });
    const [row] = await t.tdb.db.select().from(approval).where(eq(approval.id, asked.approvalId));
    expect(row).toMatchObject({ status: "executed", result: { sent: "ana" } });
    expect((await t.events("waits.done")).at(-1)?.payload).toEqual({ to: "ana" });
    // Decided once: a second yes finds it done.
    expect(await t.kernel.decideApproval(asked.approvalId, "approve", ownerCaller())).toMatchObject(
      { status: "error", code: "conflict" },
    );
  });
});
